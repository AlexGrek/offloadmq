import logging
import subprocess
import threading
import queue
import time
from pathlib import Path
from typing import Any, IO
from ..models import *
from ..transport import AgentTransport
from .helpers import *

logger = logging.getLogger(__name__)


def enqueue_output(out: IO[str], q: "queue.Queue[str]") -> None:
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


def execute_shell_bash(
    transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any], data: Path,
    job_timeout: int = 600,
) -> bool:
    logger.info(f"Executing shell.bash for task {task_id.dict()} in {data}")
    if isinstance(payload, str):
        command = payload
    else:
        command = (payload or {}).get("command")
    if not command:
        report = make_failure_report(
            task_id,
            capability,
            "No 'command' provided in payload.",
            extra_output={"error": "No 'command' provided in payload."},
        )
        return report_result(transport, report)

    try:
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(data)
        )

        q_stdout: queue.Queue[str] = queue.Queue()
        q_stderr: queue.Queue[str] = queue.Queue()
        t_stdout = threading.Thread(
            target=enqueue_output, args=(process.stdout, q_stdout)
        )
        t_stderr = threading.Thread(
            target=enqueue_output, args=(process.stderr, q_stderr)
        )

        t_stdout.daemon = True
        t_stderr.daemon = True
        t_stdout.start()
        t_stderr.start()

        full_stdout_log = ""
        full_stderr_log = ""
        deadline = time.monotonic() + job_timeout

        try:
            while process.poll() is None or not q_stdout.empty() or not q_stderr.empty():
                if process.poll() is None and time.monotonic() > deadline:
                    logger.warning(f"Task {task_id.id} exceeded timeout ({job_timeout}s), killing process")
                    process.kill()
                    process.wait()
                    raise TimeoutError(f"Task exceeded timeout of {job_timeout}s")
                try:
                    line = q_stdout.get_nowait()
                    full_stdout_log += line
                    report_progress(
                        transport, log=line, stage="running", task_id=task_id
                    )
                except queue.Empty:
                    pass

                try:
                    line = q_stderr.get_nowait()
                    full_stderr_log += line
                    report_progress(
                        transport, log=line, stage="running", task_id=task_id
                    )
                except queue.Empty:
                    pass

                time.sleep(0.1)

        except TaskCancelled:
            logger.info(f"Task {task_id.id} cancelled — killing process")
            process.kill()
            process.wait()

            # Drain remaining output from the queues
            t_stdout.join(timeout=2)
            t_stderr.join(timeout=2)
            full_stdout_log += _drain_queue(q_stdout)
            full_stderr_log += _drain_queue(q_stderr)

            cancel_output: dict[str, str | int | bool] = {
                "stdout": full_stdout_log,
                "stderr": full_stderr_log,
                "cancelled": True,
            }
            report_cancelled(
                transport, task_id, capability,
                output=cancel_output,
                remaining_log=full_stderr_log[-2048:] if full_stderr_log else None,
            )
            return True

        # Final logs after process completion
        t_stdout.join()
        t_stderr.join()
        final_stdout, final_stderr = process.communicate()
        full_stdout_log += final_stdout
        full_stderr_log += final_stderr

        # Check the return code for success or failure
        return_code = process.returncode
        if return_code == 0:
            output: dict[str, str | int] = {"stdout": full_stdout_log, "stderr": full_stderr_log}
            report = make_success_report(task_id, capability, output)
        else:
            output = {
                "stdout": full_stdout_log,
                "stderr": full_stderr_log,
                "return_code": return_code,
            }
            report = make_failure_report(
                task_id,
                capability,
                full_stderr_log or f"Command failed with return code {return_code}",
                extra_output=output,
            )

    except TimeoutError as e:
        report = make_failure_report(task_id, capability, str(e))
    except Exception as e:
        output = {"error": str(e)}
        report = make_failure_report(task_id, capability, str(e), extra_output=output)

    return report_result(transport, report)
