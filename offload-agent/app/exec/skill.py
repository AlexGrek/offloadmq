"""Executor for custom skill capabilities.

Dispatches based on skill type:

  shell — runs a bash script; parameters as SKILL_* env vars (injection-safe)
  llm   — renders a prompt template and sends it to Ollama

Security model (shell skills):
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
import tempfile
import threading
import time
from pathlib import Path

import requests

from ..models import TaskId
from ..httphelpers import HttpClient
from ..skills import Skill, get_skill_by_capability
from .helpers import (
    make_failure_report,
    make_success_report,
    report_progress,
    report_result,
)

logger = logging.getLogger(__name__)


def _normalise_payload(payload) -> dict:
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

def _enqueue_output(stream, q):
    """Read lines from a stream and put them on a queue."""
    for line in iter(stream.readline, ""):
        q.put(line)
    stream.close()


def _execute_shell(
    http: HttpClient,
    task_id: TaskId,
    capability: str,
    skill: Skill,
    payload: dict,
    data_path: Path,
) -> bool:
    """Execute a shell-type skill."""
    # Build environment with SKILL_* variables
    try:
        env = skill.build_env(payload)
    except ValueError as e:
        msg = f"Parameter validation failed: {e}"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        return report_result(http, report)

    # Write script to temp file (not from payload — trusted content)
    script_content = skill.script
    if not script_content.startswith("#!"):
        script_content = "#!/bin/bash\nset -euo pipefail\n" + script_content

    script_fd = None
    script_path = None
    try:
        script_fd, script_path = tempfile.mkstemp(suffix=".sh", prefix="skill_")
        os.write(script_fd, script_content.encode("utf-8"))
        os.close(script_fd)
        script_fd = None
        os.chmod(script_path, 0o700)

        report_progress(http, log=f"Running skill: {skill.name}\n", stage="running", task_id=task_id)

        # Execute the script
        process = subprocess.Popen(
            ["/bin/bash", script_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(data_path),
            env=env,
            # Start in a new process group for clean timeout killing
            preexec_fn=os.setsid if os.name != "nt" else None,
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

        while process.poll() is None or not q_stdout.empty() or not q_stderr.empty():
            # Check timeout
            elapsed = time.monotonic() - start_time
            if elapsed > skill.timeout and process.poll() is None:
                logger.warning(f"Skill '{skill.name}' timed out after {skill.timeout}s, killing...")
                try:
                    os.killpg(os.getpgid(process.pid), signal.SIGTERM)
                    process.wait(timeout=5)
                except Exception:
                    try:
                        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
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
                f"Skill '{skill.name}' timed out after {skill.timeout}s",
                extra_output=output,
            )
        elif process.returncode == 0:
            output = {"stdout": full_stdout, "stderr": full_stderr}
            report = make_success_report(task_id, capability, output)
        else:
            output = {"stdout": full_stdout, "stderr": full_stderr, "return_code": process.returncode}
            report = make_failure_report(
                task_id, capability,
                full_stderr or f"Skill '{skill.name}' failed with return code {process.returncode}",
                extra_output=output,
            )

    except Exception as e:
        logger.error(f"Shell skill execution error: {e}")
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
    skill: Skill,
    payload: dict,
    data_path: Path,
) -> bool:
    """Execute an LLM-type skill by rendering the prompt template and calling Ollama."""
    from ..ollama import OLLAMA_API_URL

    # Render prompt template with parameter values
    try:
        rendered_prompt = skill.render_prompt(payload)
    except ValueError as e:
        msg = f"Parameter validation failed: {e}"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        return report_result(http, report)

    model = skill.model
    if not model:
        report = make_failure_report(task_id, capability, "LLM skill has no 'model' configured")
        return report_result(http, report)

    # Build Ollama chat API payload
    messages = [{"role": "user", "content": rendered_prompt}]
    if skill.system:
        messages.insert(0, {"role": "system", "content": skill.system})

    api_payload: dict = {
        "model": model,
        "messages": messages,
        "stream": True,
    }
    if skill.temperature is not None:
        api_payload["options"] = api_payload.get("options", {})
        api_payload["options"]["temperature"] = skill.temperature
    if skill.max_tokens is not None:
        api_payload["options"] = api_payload.get("options", {})
        api_payload["options"]["num_predict"] = skill.max_tokens

    report_progress(http, log=f"Running LLM skill: {skill.name} (model: {model})\n", stage="running", task_id=task_id)
    logger.info(f"LLM skill '{skill.name}': sending to {OLLAMA_API_URL} with model={model}")

    try:
        full_response = ""
        buffer = ""
        last_flush = time.time()
        final_data: dict = {}

        r = requests.post(OLLAMA_API_URL, json=api_payload, stream=True, timeout=skill.timeout)
        r.raise_for_status()

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

        output = {
            "response": full_response,
            "model": model,
            "skill": skill.name,
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
            f"LLM skill '{skill.name}' timed out after {skill.timeout}s",
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
        logger.error(f"LLM skill execution error: {e}")
        report = make_failure_report(task_id, capability, str(e), extra_output={"error": str(e)})

    return report_result(http, report)


# ---------------------------------------------------------------------------
# Main dispatcher
# ---------------------------------------------------------------------------

def execute_skill(
    http: HttpClient,
    task_id: TaskId,
    capability: str,
    payload,
    data_path: Path,
) -> bool:
    """Execute a custom skill — dispatches to type-specific executor."""
    logger.info(f"Executing skill for task {task_id.to_wire()} capability='{capability}'")

    # Load the skill definition
    skill = get_skill_by_capability(capability)
    if not skill:
        msg = f"Skill not found for capability: {capability}"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        return report_result(http, report)

    payload = _normalise_payload(payload)

    if skill.skill_type == "shell":
        return _execute_shell(http, task_id, capability, skill, payload, data_path)
    elif skill.skill_type == "llm":
        return _execute_llm(http, task_id, capability, skill, payload, data_path)
    else:
        msg = f"Unknown skill type '{skill.skill_type}' for skill '{skill.name}'"
        logger.error(msg)
        report = make_failure_report(task_id, capability, msg)
        return report_result(http, report)
