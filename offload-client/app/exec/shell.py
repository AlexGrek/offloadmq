import logging
import subprocess
import threading
import queue
import time
from pathlib import Path
from ..models import *
from ..httphelpers import *
from .helpers import *

logger = logging.getLogger(__name__)


def enqueue_output(out, q):
    for line in iter(out.readline, ""):
        q.put(line)
    out.close()


def execute_shell_bash(
    http: HttpClient, task_id: TaskId, capability: str, payload: dict, data: Path
) -> bool:
    logger.info(
        f"Executing shell::bash for task {task_id.dict()} with payload: {payload} in {data}"
    )
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
        return report_result(http, report)

    try:
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(data)
        )

        q_stdout = queue.Queue()
        q_stderr = queue.Queue()
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

        while process.poll() is None or not q_stdout.empty() or not q_stderr.empty():
            try:
                line = q_stdout.get_nowait()
                full_stdout_log += line
                report_progress(
                    http, log=line, stage="running", task_id=task_id
                )
            except queue.Empty:
                pass

            try:
                line = q_stderr.get_nowait()
                full_stderr_log += line
                report_progress(
                    http, log=line, stage="running", task_id=task_id
                )
            except queue.Empty:
                pass

            time.sleep(0.1)

        # Final logs after process completion
        t_stdout.join()
        t_stderr.join()
        final_stdout, final_stderr = process.communicate()
        full_stdout_log += final_stdout
        full_stderr_log += final_stderr

        # Check the return code for success or failure
        return_code = process.returncode
        if return_code == 0:
            output = {"stdout": full_stdout_log, "stderr": full_stderr_log}
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

    except Exception as e:
        output = {"error": str(e)}
        report = make_failure_report(task_id, capability, str(e), extra_output=output)

    return report_result(http, report)
