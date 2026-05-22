import logging
import subprocess
import time
from typing import Any
from ..models import *
from ..transport import AgentTransport
from .helpers import *

from pathlib import Path

logger = logging.getLogger(__name__)


def execute_shellcmd_bash(
    transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any], data: Path,
    job_timeout: int = 600,
) -> bool:
    logger.info(f"Executing shellcmd.bash for task {task_id.dict()} in {data}")
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
            cwd=str(data),
        )

        deadline = time.monotonic() + job_timeout
        try:
            while process.poll() is None:
                if time.monotonic() > deadline:
                    process.kill()
                    process.wait()
                    raise TimeoutError(f"Task exceeded timeout of {job_timeout}s")
                report_progress(transport, log=None, stage="running", task_id=task_id)
                time.sleep(2)
        except TaskCancelled:
            process.kill()
            process.wait()
            stdout_out, stderr_out = process.communicate()
            output: dict[str, str | int | bool] = {
                "stdout": stdout_out,
                "stderr": stderr_out,
                "cancelled": True,
            }
            report_cancelled(transport, task_id, capability, output=output)
            return True

        stdout_out, stderr_out = process.communicate()
        return_code = process.returncode

        if return_code == 0:
            final_output: dict[str, str | int] = {"stdout": stdout_out, "stderr": stderr_out}
            report = make_success_report(task_id, capability, final_output)
        else:
            final_output = {"stdout": stdout_out, "stderr": stderr_out, "return_code": return_code}
            report = make_failure_report(
                task_id, capability,
                stderr_out or f"Command failed with return code {return_code}",
                extra_output=final_output,
            )
    except TimeoutError as e:
        report = make_failure_report(task_id, capability, str(e))
    except Exception as e:
        err_output: dict[str, str] = {"error": str(e)}
        report = make_failure_report(task_id, capability, str(e), extra_output=err_output)

    return report_result(transport, report)
