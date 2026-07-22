"""img-utils task executor — single-purpose ComfyUI image transforms.

An ``img-utils.*`` capability is one *utility* (depth map, face swap, …) rather
than a general-purpose generation model: the agent either has the workflow
installed or it does not, and the client only supplies input images plus a few
knobs.  Workflows live under ``workflows/img-utils/<utility>/<task-type>.json``,
and the utility name doubles as the default task type, so a client can omit
``workflow`` entirely.

See docs/img-utils-api.md for the payload contract.
"""

from pathlib import Path
from typing import Any

from offloadmq_agent.wire import TaskId
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.exec.imggen.executor import run_comfy_image_task

NAMESPACE = "img-utils"
PREFIX = f"{NAMESPACE}."


def execute_imgutils_comfyui(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
    job_timeout: int = 600,
) -> bool:
    """Execute an img-utils task via ComfyUI.

    capability format: img-utils.<utility>  (base, no brackets)
    """
    utility = capability.removeprefix(PREFIX)
    return run_comfy_image_task(
        transport,
        task_id,
        capability,
        payload,
        data_path,
        output_bucket,
        job_timeout,
        prefix=PREFIX,
        namespace=NAMESPACE,
        default_task_type=utility or None,
    )
