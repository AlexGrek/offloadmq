"""ONNX model registry - download, list, delete, and locate model files.

Models are stored in a configurable directory (default: ~/.offload-agent/onnx-models/).
Each model is identified by a short name (e.g. 'nudenet') and maps to a known
download URL (or mirror list) and expected filename.
"""

import hashlib
import logging
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Callable

import requests

from offloadmq_agent.settings_util import load_agent_settings as load_config

logger = logging.getLogger("agent")

_DEFAULT_MODELS_DIR = Path.home() / ".offload-agent" / "onnx-models"

# Reject tiny payloads (e.g. HTML error/login pages) so we can try the next mirror.
_MIN_VALID_ONNX_BYTES = 2_000_000

# Anonymous access to notaitech/nudenet on Hugging Face often returns 401; mirrors listed first.
ONNX_MODEL_REGISTRY: dict[str, dict[str, Any]] = {
    "nudenet": {
        "urls": [
            "https://huggingface.co/zhangsongbo365/nudenet_onnx/resolve/main/320n.onnx",
            "https://github.com/notAI-tech/NudeNet/releases/download/v3.4-weights/320n.onnx",
            "https://huggingface.co/notaitech/nudenet/resolve/main/320n.onnx",
        ],
        "filename": "320n.onnx",
        "capability": "onnx.nudenet",
        "description": "NudeNet v3 detector - NSFW region detection (YOLO-based, 320px)",
    },
    # Background removal — executor: exec/bgremove.py (preprocessing in MODEL_SPECS there).
    # BiRefNet exports re-hosted by rembg; md5s are the ones rembg pins. Chosen by the
    # examples/bgremove-poc comparison (IS-Net anime and RMBG-1.4 lost on busy scenes).
    "bgremove-birefnet-general": {
        "urls": ["https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-epoch_244.onnx"],
        "filename": "BiRefNet-general-epoch_244.onnx",
        "md5": "7a35a0141cbbc80de11d9c9a28f52697",
        "size_bytes": 972_666_916,
        "capability": "onnx.bgremove.birefnet-general",
        "description": "Background removal, best quality — anime and realistic characters incl. held props (BiRefNet Swin-L, 973 MB, MIT)",
    },
    "bgremove-birefnet-portrait": {
        "urls": ["https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-portrait-epoch_150.onnx"],
        "filename": "BiRefNet-portrait-epoch_150.onnx",
        "md5": "c3a64a6abf20250d090cd055f12a3b67",
        "size_bytes": 972_666_916,
        "capability": "onnx.bgremove.birefnet-portrait",
        "description": "Background removal for people only — softer hair, tends to drop held props (BiRefNet Swin-L, 973 MB, MIT)",
    },
    "bgremove-birefnet-lite": {
        "urls": ["https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx"],
        "filename": "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
        "md5": "4fab47adc4ff364be1713e97b7e66334",
        "size_bytes": 224_005_088,
        "capability": "onnx.bgremove.birefnet-lite",
        "description": "Background removal, small download/RAM; misses thin props (BiRefNet Swin-T, 224 MB, MIT)",
    },
}


def _model_urls(meta: dict[str, Any]) -> list[str]:
    urls = meta.get("urls")
    if isinstance(urls, list) and urls:
        return [str(u) for u in urls]
    single = meta.get("url")
    return [str(single)] if single else []


def _download_headers(url: str) -> dict[str, str]:
    """Headers for model downloads (HF token if set; UA avoids some CDN edge cases)."""
    headers: dict[str, str] = {
        "User-Agent": "omq (onnx-models; https://github.com/notAI-tech/NudeNet)",
    }
    if "huggingface.co" in url:
        token = (os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return headers


DEFAULT_MODELS_DIR = _DEFAULT_MODELS_DIR


class DownloadCancelled(RuntimeError):
    """``prepare_model`` was cancelled mid-download (not retried on the next mirror)."""


def models_dir(settings: Mapping[str, Any] | None = None) -> Path:
    """Configured ONNX models directory (``onnx_models_dir``), falling back to default.

    ``settings`` lets callers that already hold the agent settings (core) skip
    re-reading the file.
    """
    cfg = load_config() if settings is None else settings
    custom = str(cfg.get("onnx_models_dir") or "").strip()
    if custom:
        return Path(custom).expanduser()
    return _DEFAULT_MODELS_DIR


def model_path(name: str, settings: Mapping[str, Any] | None = None) -> Path | None:
    """Return the path to a downloaded model file, or None if not present."""
    meta = ONNX_MODEL_REGISTRY.get(name)
    if not meta:
        return None
    fname = str(meta["filename"])
    p = models_dir(settings) / fname
    return p if p.is_file() else None


def is_model_available(name: str) -> bool:
    return model_path(name) is not None


def list_models(settings: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
    """Return metadata for all known models with availability status."""
    root = models_dir(settings)
    result: list[dict[str, Any]] = []
    for name, meta in ONNX_MODEL_REGISTRY.items():
        fname = str(meta["filename"])
        p = root / fname
        entry: dict[str, Any] = {
            "name": name,
            "capability": meta["capability"],
            "description": meta["description"],
            "filename": fname,
            "installed": p.is_file(),
        }
        if meta.get("size_bytes"):
            entry["expected_bytes"] = int(meta["size_bytes"])
        if p.is_file():
            entry["size_bytes"] = p.stat().st_size
            entry["path"] = str(p)
        result.append(entry)
    return result


def delete_model(name: str, settings: Mapping[str, Any] | None = None) -> bool:
    """Delete a downloaded model file (and any partial download). Returns True if deleted."""
    meta = ONNX_MODEL_REGISTRY.get(name)
    if not meta:
        return False
    p = models_dir(settings) / str(meta["filename"])
    partial = p.with_suffix(".download")
    if partial.is_file():
        partial.unlink()
    if p.is_file():
        p.unlink()
        logger.info(f"[onnx] Deleted model '{name}' at {p}")
        return True
    return False


def file_md5(path: Path, cancelled: Callable[[], bool] | None = None) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(4 << 20), b""):
            if cancelled is not None and cancelled():
                raise DownloadCancelled("cancelled")
            digest.update(chunk)
    return digest.hexdigest()


def verify_model(name: str, settings: Mapping[str, Any] | None = None) -> tuple[bool, str]:
    """Check an installed model against its pinned size and md5 (reads the whole file).

    Models without a pinned md5/size only get the minimum-size sanity check.
    """
    meta = ONNX_MODEL_REGISTRY.get(name)
    if not meta:
        return False, f"unknown model {name!r}"
    p = models_dir(settings) / str(meta["filename"])
    if not p.is_file():
        return False, f"{p} missing"
    size = p.stat().st_size
    expected_size = meta.get("size_bytes")
    if expected_size and size != int(expected_size):
        return False, f"{p}: {size} bytes, expected {int(expected_size)}"
    if size < _MIN_VALID_ONNX_BYTES:
        return False, f"{p}: only {size} bytes"
    expected_md5 = meta.get("md5")
    if expected_md5:
        actual = file_md5(p)
        if actual != expected_md5:
            return False, f"{p}: md5 {actual}, expected {expected_md5}"
        return True, f"{p} ({size / 2**20:.0f} MiB, md5 ok)"
    return True, f"{p} ({size / 2**20:.0f} MiB, no pinned checksum)"


def prepare_model(
    name: str,
    on_progress: Callable[[str], None] | None = None,
    *,
    settings: Mapping[str, Any] | None = None,
    cancelled: Callable[[], bool] | None = None,
    progress_step: int = 1,
) -> Path:
    """Download a model if not already present. Returns path to the model file.

    ``progress_step`` is the percentage between download progress lines;
    ``cancelled`` is polled per chunk and aborts with :class:`DownloadCancelled`.
    Raises RuntimeError on unknown model name or download failure.
    """
    meta = ONNX_MODEL_REGISTRY.get(name)
    if not meta:
        known = ", ".join(ONNX_MODEL_REGISTRY)
        raise RuntimeError(f"Unknown ONNX model: '{name}'. Known models: {known}")

    dest_dir = models_dir(settings)
    dest_dir.mkdir(parents=True, exist_ok=True)
    fname = str(meta["filename"])
    dest = dest_dir / fname

    if dest.is_file():
        if on_progress:
            on_progress(f"Model '{name}' already downloaded at {dest}")
        return dest

    urls = _model_urls(meta)
    if not urls:
        raise RuntimeError(f"No download URLs configured for model '{name}'")

    tmp = dest.with_suffix(".download")
    errors: list[str] = []

    for url in urls:
        if tmp.is_file():
            tmp.unlink()
        try:
            if on_progress:
                on_progress(f"Downloading '{name}' from {url}...")

            downloaded = 0
            digest = hashlib.md5(usedforsecurity=False)
            last_pct = -1
            step = max(1, progress_step)
            with requests.get(url, stream=True, timeout=120, headers=_download_headers(url)) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("content-length", 0))
                with open(tmp, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=256 * 1024):
                        if cancelled is not None and cancelled():
                            raise DownloadCancelled(f"download of '{name}' cancelled")
                        f.write(chunk)
                        digest.update(chunk)
                        downloaded += len(chunk)
                        if on_progress and total:
                            pct = downloaded * 100 // total // step * step
                            if pct != last_pct:  # one line per step, not one per chunk
                                last_pct = pct
                                on_progress(f"Downloading '{name}': {pct}% ({downloaded}/{total} bytes)")

            if downloaded < _MIN_VALID_ONNX_BYTES:
                raise ValueError(
                    f"Download too small ({downloaded} bytes); expected a multi-MB ONNX file"
                )
            expected_md5 = meta.get("md5")
            if expected_md5 and digest.hexdigest() != expected_md5:
                raise ValueError(
                    f"Checksum mismatch: md5 {digest.hexdigest()}, expected {expected_md5}"
                )

            tmp.rename(dest)
            if on_progress:
                on_progress(f"Model '{name}' downloaded to {dest} ({downloaded} bytes)")
            return dest

        except DownloadCancelled:
            if tmp.is_file():
                tmp.unlink()
            raise
        except Exception as e:
            if tmp.is_file():
                tmp.unlink()
            err = f"{url}: {e}"
            errors.append(err)
            logger.warning(f"[onnx] {err}")

    raise RuntimeError(f"Failed to download model '{name}'. Tried: {' | '.join(errors)}")
