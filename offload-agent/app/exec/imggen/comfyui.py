"""Low-level ComfyUI HTTP client.

Covers all direct calls to the ComfyUI REST API:
  POST /upload/image  — stage input files
  POST /prompt        — queue a workflow graph
  GET  /history/{id}  — poll for completion
  GET  /view          — download output files
"""

import time
from typing import Any

import requests
from pathlib import Path

from ...config import load_config
from ...models import TaskId
from ...httphelpers import HttpClient
from ..helpers import report_progress

_COMFYUI_DEFAULT_URL = "http://127.0.0.1:8188"
_POLL_INTERVAL_SEC = 2
_MAX_POLL_ATTEMPTS = 150  # ~5 minutes at 2s intervals


def comfyui_url() -> str:
    """Return the ComfyUI base URL from config, falling back to the default."""
    return load_config().get("comfyui_url") or _COMFYUI_DEFAULT_URL


def upload_image(local_path: Path) -> str:
    """Upload a local image to ComfyUI's input directory. Returns the filename ComfyUI assigned."""
    with open(local_path, "rb") as f:
        r = requests.post(
            f"{comfyui_url()}/upload/image",
            files={"image": (local_path.name, f, "image/png")},
            timeout=60,
        )
    r.raise_for_status()
    return str(r.json()["name"])


def queue_prompt(workflow_graph: dict[str, Any]) -> str:
    """Submit a workflow graph to ComfyUI and return the prompt_id."""
    r = requests.post(f"{comfyui_url()}/prompt", json={"prompt": workflow_graph}, timeout=30)
    r.raise_for_status()
    prompt_id: str = str(r.json().get("prompt_id") or "")
    if not prompt_id:
        raise ValueError(f"ComfyUI did not return a prompt_id: {r.json()}")
    return prompt_id


_PROGRESS_REPORT_EVERY = 5  # report progress every N poll cycles (~10 seconds at 2s interval)


def wait_for_completion(
    prompt_id: str,
    http: HttpClient | None = None,
    task_id: TaskId | None = None,
) -> dict[str, Any]:
    """Poll /history/{prompt_id} until the job finishes. Returns the history entry.

    If ``http`` and ``task_id`` are provided, calls ``report_progress`` every
    ``_PROGRESS_REPORT_EVERY`` cycles so that a 499 (client cancel) can be
    detected and raised as ``TaskCancelled`` during the wait loop.
    """
    url = f"{comfyui_url()}/history/{prompt_id}"
    for attempt in range(_MAX_POLL_ATTEMPTS):
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        history = r.json()
        if prompt_id in history:
            entry = history[prompt_id]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                # Extract the execution_error message if present
                messages = status.get("messages", [])
                error_detail = next(
                    (m[1] for m in messages if isinstance(m, (list, tuple)) and m[0] == "execution_error"),
                    None,
                )
                if error_detail:
                    node_type = error_detail.get("node_type", "unknown node")
                    exception_message = error_detail.get("exception_message", "unknown error")
                    raise RuntimeError(
                        f"ComfyUI execution failed in {node_type}: {exception_message}"
                    )
                raise RuntimeError("ComfyUI execution failed (no error details returned)")
            result: dict[str, Any] = entry
            return result

        # Periodically report progress to detect client-side cancellation (499 → TaskCancelled).
        if http is not None and task_id is not None and attempt % _PROGRESS_REPORT_EVERY == 0:
            report_progress(http, log=None, stage="queued", task_id=task_id)

        time.sleep(_POLL_INTERVAL_SEC)
    raise TimeoutError(f"ComfyUI job {prompt_id} did not complete within the allotted time")


def download_file(filename: str, subfolder: str, file_type: str) -> tuple[bytes, str]:
    """Download a file from ComfyUI /view. Returns (content_bytes, content_type)."""
    params = {"filename": filename, "type": file_type}
    if subfolder:
        params["subfolder"] = subfolder
    r = requests.get(f"{comfyui_url()}/view", params=params, timeout=120)
    r.raise_for_status()
    return r.content, r.headers.get("Content-Type", "application/octet-stream")
