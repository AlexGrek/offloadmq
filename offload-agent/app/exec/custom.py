"""Executor for custom capabilities.

Dispatches based on execution type:

  shell — runs a bash script; parameters as CUSTOM_* env vars (injection-safe)
  llm   — renders a prompt template and sends it to Ollama

Security model (shell custom caps):
  - The script is TRUSTED (authored by agent operator, stored on disk)
  - Parameter VALUES are UNTRUSTED (come from task submitters)
  - Values are injected via environment variables, NOT string interpolation
  - Environment variables are safe from injection: $VAR expansion in bash
    does not trigger command parsing, even if the value contains ; | && etc.
"""

import json
import logging
import os
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, IO

import requests

from ..config import load_config
from ..models import TaskId
from ..httphelpers import HttpClient
from ..custom_caps import CustomCap, get_custom_cap
from .helpers import (
    TaskCancelled,
    make_failure_report,
    make_success_report,
    report_cancelled,
    report_progress,
    report_result,
)

logger = logging.getLogger(__name__)


def _normalise_payload(payload: Any) -> dict[str, Any]:
    """Normalise a payload to a dict."""
    if payload is None:
        return {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            return {}
    if not isinstance(payload, dict):
        return {}
    return payload


# ---------------------------------------------------------------------------
# Shell executor
# ---------------------------------------------------------------------------

def _enqueue_output(stream: IO[str], q: queue.Queue[str]) -> None:
    """Read lines from a stream and put them on a queue."""
    for line in iter(stream.readline, ""):
        q.put(line)
    stream.close()


def _execute_shell(
    http: HttpClient,
    task_id: TaskId,
    capability: str,
    cap: CustomCap,
    payload: dict[str, Any],
    data_path: Path,
) -> bool:
    """Execute a shell-type custom cap."""
    # Build environment with CUSTOM_* variables
    try:
        env = cap.build_env(payload)
    except ValueError as e:
        msg = f"Parameter validation failed: {e}"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        return report_result(http, report)

    # Write script to temp file (not from payload — trusted content)
    script_content = cap.script
    if not script_content or not script_content.startswith("#!"):
        script_content = f"#!/bin/bash\nset -euo pipefail\n{script_content or ''}"

    script_fd = None
    script_path = None
    try:
        script_fd, script_path = tempfile.mkstemp(suffix=".sh", prefix="custom_")
        os.write(script_fd, script_content.encode("utf-8"))
        os.close(script_fd)
        script_fd = None
        os.chmod(script_path, 0o700)

        cfg = load_config()
        agent_id = cfg.get("agentId", "unknown")
        machine = cfg.get("displayName", "unknown")
        report_progress(
            http,
            log=f"Running custom cap: {cap.name} | agent={agent_id} machine={machine}\n",
            stage="running",
            task_id=task_id,
        )

        # Execute the script
        process = subprocess.Popen(
            ["/bin/bash", script_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(data_path),
            env=env,
            # Start in a new process group for clean timeout killing (Unix only)
            preexec_fn=getattr(os, "setsid", None) if os.name != "nt" else None,
        )

        q_stdout: queue.Queue[str] = queue.Queue()
        q_stderr: queue.Queue[str] = queue.Queue()
        t_stdout = threading.Thread(target=_enqueue_output, args=(process.stdout, q_stdout), daemon=True)
        t_stderr = threading.Thread(target=_enqueue_output, args=(process.stderr, q_stderr), daemon=True)
        t_stdout.start()
        t_stderr.start()

        full_stdout = ""
        full_stderr = ""
        start_time = time.monotonic()
        timed_out = False

        try:
            while process.poll() is None or not q_stdout.empty() or not q_stderr.empty():
                # Check timeout
                elapsed = time.monotonic() - start_time
                if elapsed > cap.timeout and process.poll() is None:
                    logger.warning(f"Custom cap '{cap.name}' timed out after {cap.timeout}s, killing...")
                    try:
                        if sys.platform != "win32":
                            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
                        else:
                            process.terminate()
                        process.wait(timeout=5)
                    except Exception:
                        try:
                            if sys.platform != "win32":
                                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                            else:
                                process.kill()
                        except Exception:
                            process.kill()
                    timed_out = True
                    break

                try:
                    line = q_stdout.get_nowait()
                    full_stdout += line
                    report_progress(http, log=line, stage="running", task_id=task_id)
                except queue.Empty:
                    pass

                try:
                    line = q_stderr.get_nowait()
                    full_stderr += line
                    report_progress(http, log=line, stage="running", task_id=task_id)
                except queue.Empty:
                    pass

                time.sleep(0.1)

        except TaskCancelled:
            logger.info(f"Custom cap '{cap.name}' cancelled — killing process")
            try:
                if sys.platform != "win32":
                    os.killpg(os.getpgid(process.pid), signal.SIGTERM)
                else:
                    process.terminate()
                process.wait(timeout=5)
            except Exception:
                process.kill()
                process.wait()

            t_stdout.join(timeout=2)
            t_stderr.join(timeout=2)
            while not q_stdout.empty():
                full_stdout += q_stdout.get_nowait()
            while not q_stderr.empty():
                full_stderr += q_stderr.get_nowait()

            output = {"stdout": full_stdout, "stderr": full_stderr, "cancelled": True}
            report_cancelled(http, task_id, capability, output=output)
            return True

        # Drain remaining output
        t_stdout.join(timeout=2)
        t_stderr.join(timeout=2)

        while not q_stdout.empty():
            full_stdout += q_stdout.get_nowait()
        while not q_stderr.empty():
            full_stderr += q_stderr.get_nowait()

        if timed_out:
            output = {"stdout": full_stdout, "stderr": full_stderr, "timed_out": True}
            report = make_failure_report(
                task_id, capability,
                f"Custom cap '{cap.name}' timed out after {cap.timeout}s",
                extra_output=output,
            )
        elif process.returncode == 0:
            output = {"stdout": full_stdout, "stderr": full_stderr}
            report = make_success_report(task_id, capability, output)
        else:
            output = {"stdout": full_stdout, "stderr": full_stderr, "return_code": process.returncode}
            report = make_failure_report(
                task_id, capability,
                full_stderr or f"Custom cap '{cap.name}' failed with return code {process.returncode}",
                extra_output=output,
            )

    except Exception as e:
        logger.error(f"Shell custom cap execution error: {e}")
        report = make_failure_report(task_id, capability, str(e), extra_output={"error": str(e)})

    finally:
        if script_fd is not None:
            try:
                os.close(script_fd)
            except OSError:
                pass
        if script_path:
            try:
                os.unlink(script_path)
            except OSError:
                pass

    return report_result(http, report)


# ---------------------------------------------------------------------------
# LLM executor
# ---------------------------------------------------------------------------

def _execute_llm(
    http: HttpClient,
    task_id: TaskId,
    capability: str,
    cap: CustomCap,
    payload: dict[str, Any],
    data_path: Path,
) -> bool:
    """Execute an LLM-type custom cap by rendering the prompt template and calling Ollama."""
    from ..ollama import get_ollama_base_url
    OLLAMA_API_URL = f"{get_ollama_base_url()}/api/chat"

    # Render prompt template with parameter values
    try:
        rendered_prompt = cap.render_prompt(payload)
    except ValueError as e:
        msg = f"Parameter validation failed: {e}"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        return report_result(http, report)

    model = cap.model
    if not model:
        report = make_failure_report(task_id, capability, "LLM custom cap has no 'model' configured")
        return report_result(http, report)

    # Build Ollama chat API payload
    messages: list[dict[str, str]] = [{"role": "user", "content": rendered_prompt}]
    if cap.system:
        messages.insert(0, {"role": "system", "content": cap.system})

    api_payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": True,
    }
    if cap.temperature is not None:
        api_payload["options"] = api_payload.get("options", {})
        api_payload["options"]["temperature"] = cap.temperature
    if cap.max_tokens is not None:
        api_payload["options"] = api_payload.get("options", {})
        api_payload["options"]["num_predict"] = cap.max_tokens

    report_progress(http, log=f"Running LLM custom cap: {cap.name} (model: {model})\n", stage="running", task_id=task_id)
    logger.info(f"LLM custom cap '{cap.name}': sending to {OLLAMA_API_URL} with model={model}")

    try:
        full_response = ""
        buffer = ""
        last_flush = time.time()
        final_data: dict[str, Any] = {}
        cancelled = False

        r = requests.post(OLLAMA_API_URL, json=api_payload, stream=True, timeout=cap.timeout)
        r.raise_for_status()

        try:
            for line in r.iter_lines(decode_unicode=True):
                if not line or not line.strip():
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue

                msg = chunk.get("message", {})
                content = msg.get("content", "")
                if content:
                    buffer += content
                    full_response += content

                # Flush buffer every 2 seconds
                now = time.time()
                if now - last_flush >= 2 and buffer:
                    report_progress(http, log=buffer, stage="running", task_id=task_id)
                    buffer = ""
                    last_flush = now

                if chunk.get("done"):
                    final_data = chunk
                    if buffer:
                        report_progress(http, log=buffer, stage="running", task_id=task_id)
                        buffer = ""
        except TaskCancelled:
            cancelled = True
            r.close()
            logger.info(f"Custom LLM cap '{cap.name}' cancelled — stopping stream")

        if cancelled:
            output_data = {"response": full_response, "model": model, "name": cap.name, "cancelled": True}
            report_cancelled(http, task_id, capability, output=output_data)
            return True

        output: dict[str, Any] = {
            "response": full_response,
            "model": model,
            "name": cap.name,
        }
        if final_data.get("total_duration"):
            output["duration_ms"] = final_data["total_duration"] // 1_000_000
        if final_data.get("eval_count"):
            output["total_tokens"] = final_data["eval_count"]
            eval_dur = final_data.get("eval_duration", 0)
            if eval_dur > 0:
                output["tokens_per_second"] = round(final_data["eval_count"] / (eval_dur / 1e9), 1)

        report = make_success_report(task_id, capability, output)

    except requests.Timeout:
        report = make_failure_report(
            task_id, capability,
            f"LLM custom cap '{cap.name}' timed out after {cap.timeout}s",
        )
    except requests.RequestException as e:
        resp_text = ""
        resp = getattr(e, "response", None)
        if resp and hasattr(resp, "text"):
            resp_text = resp.text
        report = make_failure_report(
            task_id, capability,
            f"Ollama API request failed: {e}",
            extra_output={"error": str(e), "response_text": resp_text},
        )
    except Exception as e:
        logger.error(f"LLM custom cap execution error: {e}")
        report = make_failure_report(task_id, capability, str(e), extra_output={"error": str(e)})

    return report_result(http, report)


# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

def execute_custom_cap(
    http: HttpClient,
    task_id: TaskId,
    capability: str,
    payload: Any,
    data_path: Path,
) -> bool:
    """Execute a custom capability — dispatches to type-specific executor."""
    logger.info(f"Executing custom cap for task {task_id.to_wire()} capability='{capability}'")

    # Load the custom cap definition
    cap = get_custom_cap(capability)
    if not cap:
        msg = f"Custom cap not found for capability: {capability}"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        return report_result(http, report)

    payload = _normalise_payload(payload)

    if cap.exec_type == "shell":
        return _execute_shell(http, task_id, capability, cap, payload, data_path)
    elif cap.exec_type == "llm":
        return _execute_llm(http, task_id, capability, cap, payload, data_path)
    else:
        msg = f"Unknown exec type '{cap.exec_type}' for custom cap '{cap.name}'"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        return report_result(http, report)
