from ..models import *
from ..httphelpers import *
from .helpers import *


def execute_shellcmd_bash(
    http: HttpClient, task_id: TaskId, capability: str, payload: dict
) -> bool:
    typer.echo(
        f"Executing shellcmd::bash for task {task_id.dict()} with payload: {payload}"
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
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, check=True
        )
        output = {"stdout": result.stdout, "stderr": result.stderr}
        report = make_success_report(task_id, capability, output)
    except subprocess.CalledProcessError as e:
        output = {"stdout": e.stdout, "stderr": e.stderr, "return_code": e.returncode}
        report = make_failure_report(
            task_id, capability, e.stderr or str(e), extra_output=output
        )
    except Exception as e:
        output = {"error": str(e)}
        report = make_failure_report(task_id, capability, str(e), extra_output=output)

    return report_result(http, report)
