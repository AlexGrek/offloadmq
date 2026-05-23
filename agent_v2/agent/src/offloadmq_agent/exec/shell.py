"""shell.bash executor — runs a bash command and captures output."""
from __future__ import annotations

import asyncio
from typing import Any, Callable, Coroutine

from offloadmq_agent.executor import register
from offloadmq_agent.models import Task, TaskResult, TaskStatus

_MAX_OUTPUT_BYTES = 64 * 1024  # 64 KiB cap on captured stdout/stderr


@register("shell")
async def execute_shell(
    task: Task,
    report_progress: Callable[[str, str], Coroutine[Any, Any, None]],
) -> TaskResult:
    command: str = task.payload.get("command", "")
    if not command:
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.FAILED,
            error="Payload missing 'command' field",
        )

    await report_progress("starting", f"$ {command[:200]}")

    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_bytes, stderr_bytes = await proc.communicate()

    stdout = stdout_bytes[:_MAX_OUTPUT_BYTES].decode(errors="replace")
    stderr = stderr_bytes[:_MAX_OUTPUT_BYTES].decode(errors="replace")
    exit_code = proc.returncode or 0

    await report_progress("done", f"exit={exit_code}")

    status = TaskStatus.COMPLETED if exit_code == 0 else TaskStatus.FAILED
    return TaskResult(
        task_id=task.id,
        status=status,
        output={"stdout": stdout, "stderr": stderr, "exit_code": exit_code},
        error=stderr if exit_code != 0 else None,
    )
