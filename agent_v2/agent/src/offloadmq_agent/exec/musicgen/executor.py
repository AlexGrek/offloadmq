"""txt2music task executor — entry point for ComfyUI-backed music generation.

Thin wrapper over :func:`offloadmq_agent.exec.imggen.executor.run_comfy_image_task`
(same as img-utils, see that module's docstring) — reuses the shared
queue/poll/collect pipeline instead of duplicating it, supplying only the
txt2music-specific payload→injection mapping and audio output collector.
"""

from pathlib import Path
from typing import Any

from offloadmq_agent.wire import TaskId
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.exec.imggen.executor import run_comfy_image_task
from .injection import build_injection_values
from .output import build_output

_NAMESPACE = "txt2music"
_PREFIX = f"{_NAMESPACE}."


def execute_musicgen_comfyui(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
    job_timeout: int = 600,
) -> bool:
    """Execute a txt2music task via ComfyUI.

    capability format: txt2music.<workflow-name>  (base, no brackets)
    """
    return run_comfy_image_task(
        transport,
        task_id,
        capability,
        payload,
        data_path,
        output_bucket,
        job_timeout,
        prefix=_PREFIX,
        namespace=_NAMESPACE,
        build_injection_values=build_injection_values,
        build_output=build_output,
    )
