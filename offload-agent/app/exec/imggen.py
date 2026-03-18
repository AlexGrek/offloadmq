"""Image generation executor via ComfyUI API.

Implements the imggen API contract (docs/imggen-api.md).

Capability format:  imggen.<workflow-name>[<task-type>;...]
  e.g.  imggen.wan-2.1-outpaint[txt2img;img2img;upscale]

The workflow name (part after "imggen.") is the exact name of a ComfyUI
workflow whose API-format template lives in:
  workflows/<workflow-name>/<task-type>.json
  workflows/<workflow-name>/<task-type>.params.json

ComfyUI endpoints used:
  POST /upload/image       — upload input files before queuing
  POST /prompt             — queue a workflow, returns {"prompt_id": "..."}
  GET  /history/{id}       — poll for completion
  GET  /view               — download output images/video by filename
"""

import base64
import json
import re
import time
import requests
from pathlib import Path

from ..models import TaskId
from ..httphelpers import HttpClient
from ..config import load_config
from .helpers import make_failure_report, make_success_report, report_progress, report_result

_COMFYUI_DEFAULT_URL = "http://127.0.0.1:8188"


def _comfyui_url() -> str:
    """Return the ComfyUI base URL from config, falling back to the default."""
    return load_config().get("comfyui_url") or _COMFYUI_DEFAULT_URL

_POLL_INTERVAL_SEC = 2
_MAX_POLL_ATTEMPTS = 150  # ~5 minutes at 2s intervals

_WORKFLOWS_DIR = Path(__file__).parent.parent.parent / "workflows"


# ---------------------------------------------------------------------------
# ComfyUI file upload
# ---------------------------------------------------------------------------

def _upload_image(local_path: Path) -> str:
    """Upload a local image to ComfyUI's input directory. Returns the filename ComfyUI assigned."""
    with open(local_path, "rb") as f:
        r = requests.post(
            f"{_comfyui_url()}/upload/image",
            files={"image": (local_path.name, f, "image/png")},
            timeout=60,
        )
    r.raise_for_status()
    return r.json()["name"]


# ---------------------------------------------------------------------------
# Workflow template loading and parameter injection
# ---------------------------------------------------------------------------

_SAFE_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')


def _safe_path_component(value: str, field: str) -> str:
    """Reject values that could escape the workflows directory."""
    if not _SAFE_NAME_RE.match(value):
        raise ValueError(
            f"Invalid {field} '{value}': only alphanumerics, hyphens, underscores, and dots are allowed"
        )
    return value


def _load_workflow_template(workflow_name: str, task_type: str) -> tuple[dict, dict]:
    """Load the workflow graph and its parameter mapping for the given task type.

    Returns:
        (workflow_graph, param_map)
        param_map maps payload field names to lists of [node_id, input_name] pairs.
    """
    workflow_name = _safe_path_component(workflow_name, "workflow_name")
    task_type = _safe_path_component(task_type, "task_type")

    base = (_WORKFLOWS_DIR / workflow_name).resolve()
    graph_path = (base / f"{task_type}.json").resolve()
    params_path = (base / f"{task_type}.params.json").resolve()

    # Belt-and-suspenders: ensure resolved paths are still inside _WORKFLOWS_DIR
    workflows_root = _WORKFLOWS_DIR.resolve()
    if not str(graph_path).startswith(str(workflows_root) + "/"):
        raise ValueError(f"Resolved workflow path escapes workflows directory: {graph_path}")
    if not str(params_path).startswith(str(workflows_root) + "/"):
        raise ValueError(f"Resolved params path escapes workflows directory: {params_path}")

    if not graph_path.exists():
        raise FileNotFoundError(
            f"No workflow template for '{workflow_name}/{task_type}' — "
            f"expected {graph_path}"
        )
    if not params_path.exists():
        raise FileNotFoundError(
            f"No parameter map for '{workflow_name}/{task_type}' — "
            f"expected {params_path}"
        )

    with open(graph_path) as f:
        graph = json.load(f)
    with open(params_path) as f:
        param_map = json.load(f)

    return graph, param_map


def _inject_params(graph: dict, param_map: dict, values: dict) -> dict:
    """Apply payload values into the workflow graph according to param_map.

    param_map format:
        { "prompt": [["6", "text"]], "width": [["5", "width"]], ... }

    Each entry is a list of [node_id, input_name] targets to write the value to.
    Fields absent from values are left at the template's default.
    """
    import copy
    graph = copy.deepcopy(graph)

    for field, targets in param_map.items():
        if field not in values:
            continue
        value = values[field]
        for node_id, input_name in targets:
            if node_id in graph:
                graph[node_id]["inputs"][input_name] = value

    return graph


def _build_injection_values(payload: dict, task_type: str, data_path: Path) -> dict:
    """Flatten the normalised payload into a simple field → value dict ready for injection.

    File references (input_image, face_swap) are uploaded to ComfyUI here and
    replaced with the name ComfyUI assigned them.
    """
    values: dict = {}

    if prompt := payload.get("prompt"):
        values["prompt"] = prompt

    secondary = payload.get("secondary_prompts") or {}
    for key, val in secondary.items():
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
        comfyui_name = _upload_image(local_path)
        values[field] = comfyui_name

    return values


# ---------------------------------------------------------------------------
# ComfyUI job lifecycle
# ---------------------------------------------------------------------------

def _queue_prompt(workflow_graph: dict) -> str:
    """Submit a workflow graph to ComfyUI and return the prompt_id."""
    r = requests.post(f"{_comfyui_url()}/prompt", json={"prompt": workflow_graph}, timeout=30)
    r.raise_for_status()
    prompt_id = r.json().get("prompt_id")
    if not prompt_id:
        raise ValueError(f"ComfyUI did not return a prompt_id: {r.json()}")
    return prompt_id


def _wait_for_completion(prompt_id: str) -> dict:
    """Poll /history/{prompt_id} until the job finishes. Returns the history entry."""
    url = f"{_comfyui_url()}/history/{prompt_id}"
    for _ in range(_MAX_POLL_ATTEMPTS):
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        history = r.json()
        if prompt_id in history:
            return history[prompt_id]
        time.sleep(_POLL_INTERVAL_SEC)
    raise TimeoutError(f"ComfyUI job {prompt_id} did not complete within the allotted time")


def _download_file(filename: str, subfolder: str, file_type: str) -> tuple[bytes, str]:
    """Download a file from ComfyUI /view. Returns (content_bytes, content_type)."""
    params = {"filename": filename, "type": file_type}
    if subfolder:
        params["subfolder"] = subfolder
    r = requests.get(f"{_comfyui_url()}/view", params=params, timeout=120)
    r.raise_for_status()
    return r.content, r.headers.get("Content-Type", "application/octet-stream")


def _collect_images(history_entry: dict) -> list[dict]:
    images = []
    for node_output in history_entry.get("outputs", {}).values():
        for img in node_output.get("images", []):
            content, ct = _download_file(
                img.get("filename", ""),
                img.get("subfolder", ""),
                img.get("type", "output"),
            )
            images.append({
                "filename":     img.get("filename", ""),
                "content_type": ct,
                "data_base64":  base64.b64encode(content).decode("utf-8"),
            })
    return images


def _collect_video(history_entry: dict) -> dict | None:
    for node_output in history_entry.get("outputs", {}).values():
        for vid in node_output.get("videos", []) or node_output.get("gifs", []):
            content, ct = _download_file(
                vid.get("filename", ""),
                vid.get("subfolder", ""),
                vid.get("type", "output"),
            )
            return {
                "filename":     vid.get("filename", ""),
                "content_type": ct,
                "data_base64":  base64.b64encode(content).decode("utf-8"),
            }
    return None


_VIDEO_TASK_TYPES = {"txt2video", "img2video"}


def _build_output(history_entry: dict, task_type: str, prompt_id: str, seed: int | None) -> dict:
    base = {"workflow": task_type, "prompt_id": prompt_id}
    if seed is not None:
        base["seed"] = seed

    if task_type in _VIDEO_TASK_TYPES:
        video = _collect_video(history_entry)
        if not video:
            raise ValueError("ComfyUI completed but returned no video output")
        frame_count = 0
        for node_output in history_entry.get("outputs", {}).values():
            frame_count = len(node_output.get("images", [])) or frame_count
        return {**base, "frame_count": frame_count, "video": video}

    images = _collect_images(history_entry)
    if not images:
        raise ValueError("ComfyUI completed but returned no output images")
    return {**base, "image_count": len(images), "images": images}


# ---------------------------------------------------------------------------
# Executor
# ---------------------------------------------------------------------------

def execute_imggen_comfyui(
    http: HttpClient,
    task_id: TaskId,
    capability: str,
    payload: dict,
    data_path: Path,
) -> bool:
    """Execute an imggen task via ComfyUI.

    capability format: imggen.<workflow-name>  (base, no brackets)
    payload: see docs/imggen-api.md
    """
    try:
        if not isinstance(payload, dict):
            raise ValueError(f"Payload must be a dict, got {type(payload).__name__}")

        task_type = payload.get("workflow")
        if not task_type:
            raise ValueError("Payload missing required 'workflow' field")

        # Extract ComfyUI workflow name from capability string
        workflow_name = capability.removeprefix("imggen.")
        if not workflow_name or workflow_name == capability:
            raise ValueError(f"Capability '{capability}' is not a valid imggen capability")

        # Load template and inject parameters
        graph, param_map = _load_workflow_template(workflow_name, task_type)
        inject_values = _build_injection_values(payload, task_type, data_path)
        graph = _inject_params(graph, param_map, inject_values)

        # Run the job
        prompt_id = _queue_prompt(graph)
        report_progress(http, f"Queued as prompt_id={prompt_id}", "queued", task_id)

        history_entry = _wait_for_completion(prompt_id)
        report_progress(http, "Generation complete — collecting output", "collecting", task_id)

        seed = inject_values.get("seed") or payload.get("seed")
        output = _build_output(history_entry, task_type, prompt_id, seed)

        report = make_success_report(task_id, capability, output)

    except requests.RequestException as e:
        extra = {
            "error": f"ComfyUI API request failed: {e}",
            "response_text": (
                getattr(e, "response", None).text
                if getattr(e, "response", None)
                else "No response from server"
            ),
        }
        report = make_failure_report(task_id, capability, str(e), extra_output=extra)
    except Exception as e:
        report = make_failure_report(task_id, capability, str(e))

    return report_result(http, report)
