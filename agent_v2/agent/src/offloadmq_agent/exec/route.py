"""Route capability strings to executor callables."""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.wire import TaskId

ExecutorFn = Callable[..., bool]


def route_executor(cap: str) -> ExecutorFn | None:
    if cap.startswith("llm."):
        return None  # handled by native async llm executor

    if cap.startswith("docker."):
        from offloadmq_agent.exec.docker import execute_docker_run

        return execute_docker_run

    if cap.startswith("imggen."):
        from offloadmq_agent.exec.imggen import execute_imggen_comfyui

        return execute_imggen_comfyui

    if cap.startswith("img-utils."):
        from offloadmq_agent.exec.imgutils import execute_imgutils_comfyui

        return execute_imgutils_comfyui

    if cap.startswith("txt2music."):
        from offloadmq_agent.exec.musicgen import execute_musicgen_comfyui

        return execute_musicgen_comfyui

    if cap.startswith("onnx."):
        from offloadmq_agent.exec.onnx import execute_onnx

        return execute_onnx

    if cap.startswith("custom."):
        from offloadmq_agent.exec.custom import execute_custom_cap

        return execute_custom_cap

    if cap.startswith("slavemode."):
        from offloadmq_agent.exec.slavemode import execute_slavemode

        return execute_slavemode

    return {
        "debug.echo": None,
        "shell.bash": None,
        "shellcmd.bash": _shellcmd,
        "tts.kokoro": _tts,
    }.get(cap)


def _shellcmd(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data: Path,
    job_timeout: int = 600,
) -> bool:
    from offloadmq_agent.exec.shellcmd import execute_shellcmd_bash

    return execute_shellcmd_bash(
        transport, task_id, capability, payload, data, job_timeout=job_timeout
    )


def _tts(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data: Path,
    job_timeout: int = 600,
) -> bool:
    from offloadmq_agent.exec.tts import execute_kokoro_tts

    return execute_kokoro_tts(
        transport, task_id, capability, payload, data, job_timeout=job_timeout
    )
