import logging
import subprocess
import threading
import queue
import time
from pathlib import Path
from typing import Any, Callable, IO

from ..models import *
from ..transport import AgentTransport
from .helpers import *

logger = logging.getLogger(__name__)


# Image allowlist patterns per capability
IMAGE_PATTERNS: dict[str, Callable[[str], bool]] = {
    "docker.python-slim": lambda img: img.startswith("python:") and "-slim" in img,
    "docker.node": lambda img: img.startswith("node:"),
    "docker.any": lambda img: True,
}


def enqueue_output(out: IO[str], q: "queue.Queue[str]") -> None:
    """Read lines from a file-like object and enqueue them."""
    for line in iter(out.readline, ""):
        q.put(line)
    out.close()


def _drain_queue(q: "queue.Queue[str]") -> str:
    """Read all remaining lines from a queue without blocking."""
    lines: list[str] = []
    while not q.empty():
        try:
            lines.append(q.get_nowait())
        except queue.Empty:
            break
    return "".join(lines)


def execute_docker_run(
    transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any], data: Path
) -> bool:
    """Execute a Docker container with streaming output and timeout support.

    Payload schema:
    {
        "image": "python:3.12-slim",  # required
        "command": ["python", "-c", "print('hi')"],  # optional, str or list
        "env": {"VAR": "value"},  # optional
        "timeout": 60  # optional, default 60s
    }
    """
    logger.info(f"Executing {capability} for task {task_id.dict()}")

    # Parse payload
    if isinstance(payload, str):
        try:
            import json
            payload = json.loads(payload)
        except (json.JSONDecodeError, ValueError):
            report = make_failure_report(
                task_id, capability, "Payload must be a JSON object or dict.",
                extra_output={"error": "Invalid payload format"}
            )
            return report_result(transport, report)

    payload = payload or {}
    image = payload.get("image")
    command = payload.get("command")
    env_vars = payload.get("env") or {}
    timeout_sec = payload.get("timeout", 60)

    # Validate required fields
    if not image:
        report = make_failure_report(
            task_id, capability, "No 'image' provided in payload.",
            extra_output={"error": "No 'image' provided in payload."}
        )
        return report_result(transport, report)

    # Validate image against capability restrictions
    allowed_images = IMAGE_PATTERNS.get(capability)
    if allowed_images and not allowed_images(image):
        msg = f"Image '{image}' not allowed for capability '{capability}'"
        report = make_failure_report(
            task_id, capability, msg,
            extra_output={"error": msg, "image": image, "capability": capability}
        )
        return report_result(transport, report)

    # Build docker run command
    container_name = f"offloadmq-{task_id.id[:12]}"
    cmd = ["docker", "run", "--rm", "--name", container_name]

    # Add environment variables
    for key, value in env_vars.items():
        cmd.extend(["--env", f"{key}={value}"])

    # Add image
    cmd.append(image)

    # Add container command if provided
    if command:
        if isinstance(command, str):
            cmd.append(command)
        elif isinstance(command, list):
            cmd.extend(command)

    logger.info(f"Running docker command: {' '.join(cmd)}")

    timer = None
    try:
        # Start process with Popen for streaming output
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        # Start timeout timer
        def on_timeout() -> None:
            try:
                subprocess.run(["docker", "kill", container_name], timeout=5, capture_output=True)
            except Exception as e:
                logger.error(f"Failed to kill container {container_name}: {e}")

        timer = threading.Timer(timeout_sec, on_timeout)
        timer.daemon = True
        timer.start()

        # Reader threads for streaming output
        q_stdout: queue.Queue[str] = queue.Queue()
        q_stderr: queue.Queue[str] = queue.Queue()
        t_stdout = threading.Thread(target=enqueue_output, args=(process.stdout, q_stdout))
        t_stderr = threading.Thread(target=enqueue_output, args=(process.stderr, q_stderr))

        t_stdout.daemon = True
        t_stderr.daemon = True
        t_stdout.start()
        t_stderr.start()

        full_stdout_log = ""
        full_stderr_log = ""

        # Collect output while process runs
        try:
            while process.poll() is None or not q_stdout.empty() or not q_stderr.empty():
                try:
                    line = q_stdout.get_nowait()
                    full_stdout_log += line
                    report_progress(transport, log=line, stage="running", task_id=task_id)
                except queue.Empty:
                    pass

                try:
                    line = q_stderr.get_nowait()
                    full_stderr_log += line
                    report_progress(transport, log=line, stage="running", task_id=task_id)
                except queue.Empty:
                    pass

                time.sleep(0.1)

        except TaskCancelled:
            timer.cancel()
            logger.info(f"Task {task_id.id} cancelled — killing container {container_name}")
            try:
                subprocess.run(["docker", "kill", container_name], timeout=5, capture_output=True)
            except Exception:
                pass
            process.wait()

            t_stdout.join(timeout=2)
            t_stderr.join(timeout=2)
            full_stdout_log += _drain_queue(q_stdout)
            full_stderr_log += _drain_queue(q_stderr)

            output = {
                "stdout": full_stdout_log,
                "stderr": full_stderr_log,
                "cancelled": True,
            }
            report_cancelled(transport, task_id, capability, output=output)
            return True

        # Cancel the timeout timer since process finished
        timer.cancel()

        # Join reader threads and get any remaining output
        t_stdout.join()
        t_stderr.join()
        final_stdout, final_stderr = process.communicate()
        full_stdout_log += final_stdout
        full_stderr_log += final_stderr

        # Check exit code
        exit_code = process.returncode
        if exit_code == 0:
            output = {
                "stdout": full_stdout_log,
                "stderr": full_stderr_log,
                "exit_code": 0,
            }
            report = make_success_report(task_id, capability, output)
        else:
            output = {
                "stdout": full_stdout_log,
                "stderr": full_stderr_log,
                "exit_code": exit_code,
            }
            report = make_failure_report(
                task_id,
                capability,
                full_stderr_log or f"Container exited with code {exit_code}",
                extra_output=output,
            )

    except Exception as e:
        if timer:
            timer.cancel()

        # Try to kill container in case it's still running
        try:
            subprocess.run(["docker", "kill", container_name], timeout=5, capture_output=True)
        except Exception:
            pass

        output = {"error": str(e)}
        report = make_failure_report(task_id, capability, str(e), extra_output=output)

    return report_result(transport, report)
