"""debug.echo executor — echoes the payload back as output."""
from __future__ import annotations

import asyncio

from offloadmq_agent.context import ExecContext
from offloadmq_agent.executor import register
from offloadmq_agent.models import Task, TaskResult, TaskStatus


@register("debug")
async def execute_debug(task: Task, ctx: ExecContext) -> TaskResult:
    delay = float(task.payload.get("delay", 0))
    await ctx.progress("running", f"echo payload (delay={delay}s)", payload=task.payload)

    if delay > 0:
        # Sleep in small slices so cancellation stays responsive.
        elapsed = 0.0
        while elapsed < delay:
            ctx.raise_if_cancelled()
            await asyncio.sleep(min(0.25, delay - elapsed))
            elapsed += 0.25

    return TaskResult(
        task_id=task.id,
        status=TaskStatus.COMPLETED,
        output={"echo": task.payload},
    )
