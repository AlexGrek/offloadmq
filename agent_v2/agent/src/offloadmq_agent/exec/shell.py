"""shell.bash executor — runs a shell command and captures output."""
from __future__ import annotations

import asyncio

from offloadmq_agent.context import ExecContext
from offloadmq_agent.executor import register
from offloadmq_agent.models import Task, TaskResult, TaskStatus

_MAX_OUTPUT_BYTES = 64 * 1024  # 64 KiB cap on captured stdout/stderr


@register("shell")
async def execute_shell(task: Task, ctx: ExecContext) -> TaskResult:
    command: str = task.payload.get("command", "")
    if not command:
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.FAILED,
            error="Payload missing 'command' field",
        )

    await ctx.progress("starting", f"$ {command[:200]}")

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # Wait for completion, polling the cancel flag so the UI can stop it.
    while True:
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(), timeout=0.5
            )
            break
        except asyncio.TimeoutError:
            if ctx.cancelled:
                proc.kill()
                await proc.wait()
                await ctx.warn("cancelled — killed subprocess")
                return TaskResult(
                    task_id=task.id,
                    status=TaskStatus.CANCELLED,
                    error="Cancelled by user",
                )

    stdout = stdout_bytes[:_MAX_OUTPUT_BYTES].decode(errors="replace")
    stderr = stderr_bytes[:_MAX_OUTPUT_BYTES].decode(errors="replace")
    exit_code = proc.returncode or 0

    await ctx.progress("done", f"exit={exit_code}", exit_code=exit_code)

    status = TaskStatus.COMPLETED if exit_code == 0 else TaskStatus.FAILED
    return TaskResult(
        task_id=task.id,
        status=status,
        output={"stdout": stdout, "stderr": stderr, "exit_code": exit_code},
        error=stderr if exit_code != 0 else None,
    )
