"""Workflow template loading and parameter injection.

Handles discovering the workflows directory, loading JSON templates,
and building the injected graph ready for ComfyUI submission.
"""

import copy
import json
import os
import re
from pathlib import Path

from .comfyui import upload_image

_SAFE_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')


def _safe_path_component(value: str, field: str) -> str:
    """Reject values that could escape the workflows directory."""
    if not _SAFE_NAME_RE.match(value):
        raise ValueError(
            f"Invalid {field} '{value}': only alphanumerics, hyphens, underscores, and dots are allowed"
        )
    return value


def _find_workflows_dir() -> Path:
    """Locate the workflows directory, persisting across PyInstaller rebuilds.

    Priority:
    1. Environment variable OFFLOAD_WORKFLOWS_DIR
    2. ~/.offload-agent/workflows (persistent for packaged agents)
    3. CWD/workflows (explicit local setup)
    4. App structure (development fallback)
    """
    if env_dir := os.getenv("OFFLOAD_WORKFLOWS_DIR"):
        env_path = Path(env_dir)
        if env_path.is_dir():
            return env_path

    home_workflows = Path.home() / ".offload-agent" / "workflows"
    if home_workflows.is_dir():
        return home_workflows

    cwd_workflows = Path.cwd() / "workflows"
    if cwd_workflows.is_dir():
        return cwd_workflows

    # Development fallback: relative to source tree
    dev_workflows = Path(__file__).parent.parent.parent.parent / "workflows"
    if dev_workflows.is_dir():
        return dev_workflows

    # No workflows directory found anywhere — create the persistent home
    # directory so packaged (PyInstaller) builds don't fall back to the
    # ephemeral _MEIPASS temp directory.
    home_workflows.mkdir(parents=True, exist_ok=True)
    return home_workflows


WORKFLOWS_DIR = _find_workflows_dir()


def load_workflow_template(workflow_name: str, task_type: str) -> tuple[dict, dict]:
    """Load the workflow graph and its parameter mapping for the given task type.

    Returns:
        (workflow_graph, param_map)
        param_map maps payload field names to lists of [node_id, input_name] pairs.
    """
    workflow_name = _safe_path_component(workflow_name, "workflow_name")
    task_type = _safe_path_component(task_type, "task_type")

    workflows_root = WORKFLOWS_DIR.resolve()
    base = (WORKFLOWS_DIR / workflow_name).resolve()
    graph_path = (base / f"{task_type}.json").resolve()
    params_path = (base / f"{task_type}.params.json").resolve()

    # Belt-and-suspenders: ensure resolved paths are still inside WORKFLOWS_DIR
    try:
        graph_path.relative_to(workflows_root)
        params_path.relative_to(workflows_root)
    except ValueError:
        raise ValueError(f"Resolved workflow path escapes workflows directory: {graph_path}")

    if not graph_path.exists():
        raise FileNotFoundError(
            f"No workflow template for '{workflow_name}/{task_type}' — expected {graph_path}"
        )
    if not params_path.exists():
        raise FileNotFoundError(
            f"No parameter map for '{workflow_name}/{task_type}' — expected {params_path}"
        )

    with open(graph_path) as f:
        graph = json.load(f)
    with open(params_path) as f:
        param_map = json.load(f)

    return graph, param_map


def inject_params(graph: dict, param_map: dict, values: dict) -> dict:
    """Apply payload values into the workflow graph according to param_map.

    param_map format:
        { "prompt": [["6", "text"]], "width": [["5", "width"]], ... }

    Each entry is a list of [node_id, input_name] targets to write the value to.
    Fields absent from values are left at the template's default.
    """
    graph = copy.deepcopy(graph)
    for field, targets in param_map.items():
        if field not in values:
            continue
        value = values[field]
        for node_id, input_name in targets:
            if node_id in graph:
                graph[node_id]["inputs"][input_name] = value
    return graph


def build_injection_values(payload: dict, task_type: str, data_path: Path) -> dict:
    """Flatten the normalised payload into a field → value dict ready for injection.

    File references (input_image, face_swap) are uploaded to ComfyUI here and
    replaced with the filename ComfyUI assigned them.
    """
    values: dict = {}

    if prompt := payload.get("prompt"):
        values["prompt"] = prompt

    for key, val in (payload.get("secondary_prompts") or {}).items():
        values[key] = val  # e.g. "negative" → negative prompt text

    if resolution := payload.get("resolution"):
        if w := resolution.get("width"):
            values["width"] = int(w)
        if h := resolution.get("height"):
            values["height"] = int(h)

    if seed := payload.get("seed"):
        values["seed"] = int(seed)

    if length := payload.get("length"):
        values["length"] = int(length)

    if upscale := payload.get("upscale"):
        values["upscale"] = float(upscale)

    for field in ("input_image", "face_swap"):
        filename = payload.get(field)
        if not filename:
            continue
        local_path = data_path / filename
        if not local_path.exists():
            raise FileNotFoundError(
                f"File '{filename}' not found in task data directory (field: {field})"
            )
        values[field] = upload_image(local_path)

    return values
