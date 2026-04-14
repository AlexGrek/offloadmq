"""ONNX model registry — download, list, delete, and locate model files.

Models are stored in a configurable directory (default: ~/.offload-agent/onnx-models/).
Each model is identified by a short name (e.g. 'nudenet') and maps to a known
download URL and expected filename.
"""

import logging
from pathlib import Path
from typing import Any, Callable

import requests

from .config import load_config

logger = logging.getLogger("agent")

_DEFAULT_MODELS_DIR = Path.home() / ".offload-agent" / "onnx-models"

ONNX_MODEL_REGISTRY: dict[str, dict[str, str]] = {
    "nudenet": {
        "url": "https://huggingface.co/notaitech/nudenet/resolve/main/320n.onnx",
        "filename": "320n.onnx",
        "capability": "onnx.nudenet",
        "description": "NudeNet v3 detector — NSFW region detection (YOLO-based, 320px)",
    },
}


def models_dir() -> Path:
    """Configured ONNX models directory, falling back to default."""
    cfg = load_config()
    custom = cfg.get("onnx_models_dir")
    if custom:
        return Path(str(custom)).expanduser()
    return _DEFAULT_MODELS_DIR


def model_path(name: str) -> Path | None:
    """Return the path to a downloaded model file, or None if not present."""
    meta = ONNX_MODEL_REGISTRY.get(name)
    if not meta:
        return None
    p = models_dir() / meta["filename"]
    return p if p.is_file() else None


def is_model_available(name: str) -> bool:
    return model_path(name) is not None


def list_models() -> list[dict[str, Any]]:
    """Return metadata for all known models with availability status."""
    result: list[dict[str, Any]] = []
    for name, meta in ONNX_MODEL_REGISTRY.items():
        p = models_dir() / meta["filename"]
        entry: dict[str, Any] = {
            "name": name,
            "capability": meta["capability"],
            "description": meta["description"],
            "filename": meta["filename"],
            "installed": p.is_file(),
        }
        if p.is_file():
            entry["size_bytes"] = p.stat().st_size
            entry["path"] = str(p)
        result.append(entry)
    return result


def delete_model(name: str) -> bool:
    """Delete a downloaded model file. Returns True if deleted."""
    p = model_path(name)
    if p and p.is_file():
        p.unlink()
        logger.info(f"[onnx] Deleted model '{name}' at {p}")
        return True
    return False


def prepare_model(
    name: str,
    on_progress: Callable[[str], None] | None = None,
) -> Path:
    """Download a model if not already present. Returns path to the model file.

    Raises RuntimeError on unknown model name or download failure.
    """
    meta = ONNX_MODEL_REGISTRY.get(name)
    if not meta:
        known = ", ".join(ONNX_MODEL_REGISTRY)
        raise RuntimeError(f"Unknown ONNX model: '{name}'. Known models: {known}")

    dest_dir = models_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / meta["filename"]

    if dest.is_file():
        if on_progress:
            on_progress(f"Model '{name}' already downloaded at {dest}")
        return dest

    url = meta["url"]
    if on_progress:
        on_progress(f"Downloading '{name}' from {url}...")

    tmp = dest.with_suffix(".download")
    try:
        resp = requests.get(url, stream=True, timeout=30)
        resp.raise_for_status()
        total = int(resp.headers.get("content-length", 0))
        downloaded = 0

        with open(tmp, "wb") as f:
            for chunk in resp.iter_content(chunk_size=256 * 1024):
                f.write(chunk)
                downloaded += len(chunk)
                if on_progress and total:
                    pct = downloaded * 100 // total
                    on_progress(f"Downloading '{name}': {pct}% ({downloaded}/{total} bytes)")

        tmp.rename(dest)
        if on_progress:
            on_progress(f"Model '{name}' downloaded to {dest} ({downloaded} bytes)")
        return dest

    except Exception as e:
        if tmp.is_file():
            tmp.unlink()
        raise RuntimeError(f"Failed to download model '{name}': {e}") from e
