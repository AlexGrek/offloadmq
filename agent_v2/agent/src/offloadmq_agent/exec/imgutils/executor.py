"""img-utils task executor — single-purpose ComfyUI image transforms.

An ``img-utils.*`` capability is one *tool* (depth map, face swap, …) rather than
a general-purpose generation model: the agent either has the workflow installed
or it does not, and the client only supplies input images plus a few knobs.

Layout follows the same convention as imggen — ``workflows/img-utils/<pack>/<task-type>.json``,
where the directory names the model/pack and the file names the operation, e.g.
``img-utils/image_lotus_depth_v1_1/depth.json``.  Because a pack almost always
installs exactly one operation, a client may omit ``workflow`` and the agent
resolves it from the directory.

See docs/img-utils-api.md for the payload contract.
"""

from pathlib import Path
from typing import Any

from offloadmq_agent.wire import TaskId
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.exec.imggen.executor import run_comfy_image_task
from offloadmq_agent.exec.imggen.workflow import list_task_types

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

    capability format: img-utils.<pack>  (base, no brackets)
    """
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
        default_task_type=_sole_task_type(capability.removeprefix(PREFIX)),
    )


def _sole_task_type(pack: str) -> str | None:
    """The pack's only operation, used when the client omits ``workflow``.

    Deliberately ``None`` when a pack installs several operations: guessing which
    one the caller meant would silently run the wrong transform, so the caller is
    made to say. The directory name is *not* a fallback — packs are named after
    the model (``image_lotus_depth_v1_1``), not the operation (``depth``).
    """
    task_types = list_task_types(pack, namespace=NAMESPACE)
    return task_types[0] if len(task_types) == 1 else None
