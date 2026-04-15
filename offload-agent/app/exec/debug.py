import typer
from typing import Any
from ..models import *
from ..transport import AgentTransport
from .helpers import *

from pathlib import Path

def execute_debug_echo(transport: AgentTransport, task_id: TaskId, capability: str, payload: dict[str, Any], data: Path) -> bool:
    typer.echo(f"Executing debug.echo for task {task_id.model_dump()} with payload: {payload}, path: {data}")
    report = make_success_report(task_id, capability, payload)
    return report_result(transport, report)
