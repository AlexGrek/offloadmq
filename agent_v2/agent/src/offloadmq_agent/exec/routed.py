"""Routed executors — full pipeline for non-native capability families."""
from __future__ import annotations

from offloadmq_agent import executor as executor_mod
from offloadmq_agent.context import ExecContext
from offloadmq_agent.models import Task, TaskResult
from offloadmq_agent.pipeline import run_routed_task


async def _run_routed(task: Task, ctx: ExecContext) -> TaskResult:
    hook = None
    if ctx._progress_reporter is not None:
        hook = lambda stage, msg: ctx._progress_reporter(stage, msg, "")  # type: ignore[misc]
    return await run_routed_task(task, ctx, progress_hook=hook)


def register_routed_executors() -> None:
    for prefix in (
        "docker",
        "imggen",
        "txt2music",
        "onnx",
        "custom",
        "slavemode",
        "tts",
        "shellcmd",
    ):
        executor_mod._registry[prefix] = _run_routed
