"""debug.echo executor — echoes the payload back as output."""
from __future__ import annotations

from typing import Any, Callable, Coroutine

from offloadmq_agent.executor import register
from offloadmq_agent.models import Task, TaskResult, TaskStatus


@register("debug")
async def execute_debug(
    task: Task,
    report_progress: Callable[[str, str], Coroutine[Any, Any, None]],
) -> TaskResult:
    await report_progress("running", f"echo payload: {task.payload}")
    return TaskResult(
        task_id=task.id,
        status=TaskStatus.COMPLETED,
        output={"echo": task.payload},
    )
