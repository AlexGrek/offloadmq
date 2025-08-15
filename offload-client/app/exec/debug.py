from ..models import *
from ..httphelpers import *
from .helpers import *

def execute_debug_echo(http: HttpClient, task_id: TaskId, capability: str, payload: dict) -> bool:
    typer.echo(f"Executing debug::echo for task {task_id.model_dump()} with payload: {payload}")
    report = make_success_report(task_id, capability, payload)
    return report_result(http, report)
