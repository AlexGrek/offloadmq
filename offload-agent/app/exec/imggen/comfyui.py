"""Low-level ComfyUI HTTP client.

Covers all direct calls to the ComfyUI REST API:
  POST /upload/image  — stage input files
  POST /prompt        — queue a workflow graph
  GET  /history/{id}  — poll for completion
  GET  /view          — download output files
"""

import time

import requests
from pathlib import Path

from ...config import load_config

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
    return r.json()["name"]


def queue_prompt(workflow_graph: dict) -> str:
    """Submit a workflow graph to ComfyUI and return the prompt_id."""
    r = requests.post(f"{comfyui_url()}/prompt", json={"prompt": workflow_graph}, timeout=30)
    r.raise_for_status()
    prompt_id = r.json().get("prompt_id")
    if not prompt_id:
        raise ValueError(f"ComfyUI did not return a prompt_id: {r.json()}")
    return prompt_id


def wait_for_completion(prompt_id: str) -> dict:
    """Poll /history/{prompt_id} until the job finishes. Returns the history entry."""
    url = f"{comfyui_url()}/history/{prompt_id}"
    for _ in range(_MAX_POLL_ATTEMPTS):
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        history = r.json()
        if prompt_id in history:
            return history[prompt_id]
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
