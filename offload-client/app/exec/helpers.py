import typer
from ..models import *
from ..httphelpers import *


def report_result(http: HttpClient, report: TaskResultReport) -> bool:
    # POST /private/agent/task/resolve/{cap}/{id}
    q = report.task_id.quoted()
    try:
        typer.echo(f"Reporting result for task id={q.id} cap={q.cap}")
        resp = http.post(
            "private",
            "agent",
            "task",
            "resolve",
            q.cap,
            q.id,
            json_body=report.to_wire(),
            timeout=300,
        )
        if resp.content:
            try:
                typer.echo(resp.content.decode("utf-8", errors="ignore"))
            except Exception:
                pass
        resp.raise_for_status()
        typer.echo(f"Task result reported. Status Code: {resp.status_code}")
        return True
    except requests.RequestException as e:
        typer.echo(f"Failed to report task result: {e}")
        return False
    
def report_progress(http: HttpClient, log: Optional[str], stage: Optional[str], task_id: TaskId) -> bool:
    # POST /private/agent/task/resolve/{cap}/{id}
    print("Sending partial logs: ", log)
    q = task_id.quoted()
    report = TaskProgressReport(id=task_id, stage=stage, log_update=log)
    try:
        typer.echo(f"Reporting result for task id={q.id} cap={q.cap}")
        resp = http.post(
            "private",
            "agent",
            "task",
            "progress",
            q.cap,
            q.id,
            json_body=report.to_wire(),
            timeout=300,
        )
        if resp.content:
            try:
                typer.echo(resp.content.decode("utf-8", errors="ignore"))
            except Exception:
                pass
        resp.raise_for_status()
        typer.echo(f"Task result reported. Status Code: {resp.status_code}")
        return True
    except requests.RequestException as e:
        typer.echo(f"Failed to report task result: {e}")
        return False


def make_success_report(
    task_id: TaskId, capability: str, output: dict, duration_sec: float = 12.5
) -> TaskResultReport:
    return TaskResultReport(
        id=task_id,
        status=TaskResultStatus(status="success", data=timedelta(seconds=duration_sec)),
        output=output,
        capability=capability,
    )


def make_failure_report(
    task_id: TaskId,
    capability: str,
    message: str,
    duration_sec: float = 5.0,
    extra_output: Optional[dict] = None,
) -> TaskResultReport:
    return TaskResultReport(
        id=task_id,
        status=TaskResultStatus(
            status="failure", data=(message, timedelta(seconds=duration_sec))
        ),
        output=extra_output or {"error": message},
        capability=capability,
    )
