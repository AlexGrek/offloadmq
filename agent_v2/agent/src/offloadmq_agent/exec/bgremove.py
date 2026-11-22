"""onnx.bgremove.* executor — background removal with ONNX segmentation models.

One capability per installed model (``onnx.bgremove.birefnet-general``,
``-portrait``, ``-lite``); the model files are managed by the shared ONNX
registry (``offloadmq_agent.onnx_models``) and advertised only once present on
disk. Install / configure them with ``omq bgremove …``, the GUI's Background
removal page, or ``slavemode.onnx-models-prepare``; device, threads and session
caching come from the agent settings (see ``bgremove_runtime``).

Pipeline per image: model → soft alpha matte (upscaled to the input resolution) →
foreground colour estimation, so semi-transparent hair stops carrying the old
background's colour → encode as a transparent PNG/WebP, or composite onto a solid
colour (JPEG is always flattened). Optional crop-to-subject for sprite sheets.

See docs/bgremove-api.md for the payload contract.
"""

from __future__ import annotations

import io
import logging
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from offloadmq_agent.exec.reporting import (
    TaskCancelled,
    make_failure_report,
    make_success_report,
    report_cancelled,
    report_progress,
    report_result,
)
from offloadmq_agent.exec.bgremove_runtime import BgRemoveConfig, resolve_providers
from offloadmq_agent.onnx_models import ONNX_MODEL_REGISTRY, model_path
from offloadmq_agent.settings_util import load_agent_settings
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.wire import TaskId

if TYPE_CHECKING:
    import numpy as np
    import onnxruntime as ort
    from PIL.Image import Image as PilImage

logger = logging.getLogger("agent")

CAPABILITY_PREFIX = "onnx.bgremove."

_IMAGENET_MEAN = (0.485, 0.456, 0.406)
_IMAGENET_STD = (0.229, 0.224, 0.225)


@dataclass(frozen=True)
class ModelSpec:
    """How to feed one model and read its output. Inputs are stretched to a square."""

    size: int  # square input edge
    mean: tuple[float, float, float]
    std: tuple[float, float, float]
    sigmoid: bool  # output is raw logits


_BIREFNET = ModelSpec(1024, _IMAGENET_MEAN, _IMAGENET_STD, sigmoid=True)

# Keyed by ONNX registry name. Preprocessing follows BiRefNet's reference inference
# code; model choice and settings were validated in examples/bgremove-poc.
MODEL_SPECS: dict[str, ModelSpec] = {
    "bgremove-birefnet-general": _BIREFNET,
    "bgremove-birefnet-portrait": _BIREFNET,
    "bgremove-birefnet-lite": _BIREFNET,
}

# name → (Pillow format, extension, content type, supports alpha)
_FORMATS: dict[str, tuple[str, str, str, bool]] = {
    "png": ("PNG", ".png", "image/png", True),
    "webp": ("WEBP", ".webp", "image/webp", True),
    "jpeg": ("JPEG", ".jpg", "image/jpeg", False),
    "jpg": ("JPEG", ".jpg", "image/jpeg", False),
}
DEFAULT_FORMAT = "png"
# JPEG cannot be transparent; a JPEG request without a colour gets this one.
DEFAULT_OPAQUE_BACKGROUND = (255, 255, 255)

_IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"})
_HEX_COLOR = re.compile(r"^#?([0-9a-fA-F]{6})$")
_TRANSPARENT = ("transparent", "none", "")


def registry_name(capability: str) -> str:
    """``onnx.bgremove.birefnet-general[...]`` → ``bgremove-birefnet-general``."""
    base = capability.split("[", 1)[0]
    return "bgremove-" + base[len(CAPABILITY_PREFIX):]


# --------------------------------------------------------------------------
# payload
# --------------------------------------------------------------------------

def parse_color(raw: Any) -> tuple[int, int, int] | None:
    """``"#RRGGBB"`` / ``"RRGGBB"`` / ``[r, g, b]`` → RGB; ``"transparent"``/None → None."""
    if raw is None:
        return None
    if isinstance(raw, str):
        if raw.strip().lower() in _TRANSPARENT:
            return None
        m = _HEX_COLOR.match(raw.strip())
        if not m:
            raise ValueError(f"background must be '#RRGGBB', [r, g, b] or 'transparent', got {raw!r}")
        v = m.group(1)
        return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    if isinstance(raw, (list, tuple)) and len(raw) == 3:
        rgb = tuple(int(c) for c in raw)
        if not all(0 <= c <= 255 for c in rgb):
            raise ValueError(f"background channels must be 0..255, got {list(raw)}")
        return rgb[0], rgb[1], rgb[2]
    raise ValueError(f"background must be '#RRGGBB', [r, g, b] or 'transparent', got {raw!r}")


@dataclass(frozen=True)
class BgRemoveSpec:
    fmt: str
    background: tuple[int, int, int] | None  # None = keep transparency
    crop: bool
    padding: int
    refine_foreground: bool
    alpha_threshold: float | None
    return_mask: bool
    quality: int | None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "BgRemoveSpec":
        fmt = str(payload.get("format") or DEFAULT_FORMAT).lower()
        if fmt not in _FORMATS:
            raise ValueError(f"Unsupported format {fmt!r} — supported: png, webp, jpeg")

        background = parse_color(payload.get("background"))
        if background is None and not _FORMATS[fmt][3]:
            background = DEFAULT_OPAQUE_BACKGROUND

        padding = int(payload.get("padding") or 0)
        if not 0 <= padding <= 4096:
            raise ValueError(f"padding must be between 0 and 4096, got {padding}")

        threshold_raw = payload.get("alpha_threshold")
        threshold = float(threshold_raw) if threshold_raw is not None else None
        if threshold is not None and not 0.0 < threshold < 1.0:
            raise ValueError(f"alpha_threshold must be between 0 and 1 (exclusive), got {threshold}")

        quality_raw = payload.get("quality")
        quality = int(quality_raw) if quality_raw is not None else None
        if quality is not None and not 1 <= quality <= 100:
            raise ValueError(f"quality must be between 1 and 100, got {quality}")

        return cls(
            fmt=fmt,
            background=background,
            crop=bool(payload.get("crop", False)),
            padding=padding,
            refine_foreground=bool(payload.get("refine_foreground", True)),
            alpha_threshold=threshold,
            return_mask=bool(payload.get("return_mask", False)),
            quality=quality,
        )


def _select_inputs(payload: dict[str, Any], data_path: Path) -> list[Path]:
    """The images to process — named in the payload, or every image in the bucket."""
    named = payload.get("input_image")
    if named is None:
        named = payload.get("input_images")
    names = [named] if isinstance(named, str) else [str(n) for n in named] if isinstance(named, list) else []

    if names:
        root = data_path.resolve()
        files: list[Path] = []
        for name in names:
            candidate = (data_path / name).resolve()
            # A bucket filename is client-controlled; keep it inside the task directory.
            if not candidate.is_relative_to(root):
                raise ValueError(f"Input image {name!r} escapes the task directory")
            if not candidate.is_file():
                raise FileNotFoundError(f"Input image {name!r} was not found in the task's file bucket")
            files.append(candidate)
        return files

    files = sorted(
        p for p in data_path.iterdir() if p.is_file() and p.suffix.lower() in _IMAGE_SUFFIXES
    ) if data_path.is_dir() else []
    if not files:
        raise ValueError(
            "No input images found — upload images to a bucket and pass it as 'file_bucket', "
            "or name them with 'input_image'"
        )
    return files


# --------------------------------------------------------------------------
# inference
# --------------------------------------------------------------------------

_sessions: dict[str, "ort.InferenceSession"] = {}
# (providers, threads) the cached sessions were built with; a settings change drops them.
_sessions_signature: tuple[tuple[str, ...], int] | None = None
_sessions_lock = threading.Lock()


def release_sessions() -> int:
    """Drop every cached session (frees several GB per BiRefNet). Returns how many."""
    global _sessions_signature
    with _sessions_lock:
        count = len(_sessions)
        _sessions.clear()
        _sessions_signature = None
    return count


def _session(model_file: Path, cfg: BgRemoveConfig) -> "ort.InferenceSession":
    """Load a session for the configured device; cached when ``keep_loaded`` is on."""
    import onnxruntime as ort

    global _sessions_signature
    providers = resolve_providers(cfg.device, ort.get_available_providers())
    signature = (tuple(providers), cfg.threads)
    key = str(model_file)
    with _sessions_lock:
        if _sessions_signature != signature:
            _sessions.clear()
            _sessions_signature = signature
        sess = _sessions.get(key)
        if sess is None:
            opts = ort.SessionOptions()
            opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            if cfg.threads:
                opts.intra_op_num_threads = cfg.threads
            sess = ort.InferenceSession(key, opts, providers=providers)
            logger.info(f"[bgremove] loaded {model_file.name} with {sess.get_providers()}")
            if cfg.keep_loaded:
                _sessions[key] = sess
        return sess


def _preprocess(img: PilImage, spec: ModelSpec) -> "np.ndarray":
    """Normalised NCHW float tensor of the image stretched to the model's square input."""
    import numpy as np
    from PIL import Image

    canvas = img.resize((spec.size, spec.size), Image.Resampling.BILINEAR)
    pixels = np.asarray(canvas, dtype=np.float32) / 255.0
    arr = (pixels - np.array(spec.mean, np.float32)) / np.array(spec.std, np.float32)
    return arr.transpose(2, 0, 1)[None].astype(np.float32)


def predict_alpha(sess: "ort.InferenceSession", img: PilImage, spec: ModelSpec) -> "np.ndarray":
    """Soft alpha in [0, 1] at the input image's resolution (HxW float32)."""
    import numpy as np
    from PIL import Image

    out = sess.run(None, {sess.get_inputs()[0].name: _preprocess(img, spec)})[0]
    logits = np.asarray(out, dtype=np.float32).reshape(out.shape[-2], out.shape[-1])
    prob = 1.0 / (1.0 + np.exp(-logits)) if spec.sigmoid else logits
    pred = np.clip(prob, 0.0, 1.0)
    mask = Image.fromarray((pred * 255).round().astype(np.uint8), "L")
    resized = mask.resize(img.size, Image.Resampling.BILINEAR)
    return np.asarray(resized, dtype=np.float32) / 255.0


# --------------------------------------------------------------------------
# compositing
# --------------------------------------------------------------------------

def _box_blur(a: "np.ndarray", r: int) -> "np.ndarray":
    """Separable mean filter (edge-clamped), via cumulative sums — O(1) per pixel in r."""
    import numpy as np

    def blur_axis(x: "np.ndarray", axis: int) -> "np.ndarray":
        pad = [(0, 0)] * x.ndim
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(x, pad, mode="edge"), axis=axis, dtype=np.float64)
        n = x.shape[axis]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        return ((hi - lo) / (2 * r + 1)).astype(np.float32)

    return blur_axis(blur_axis(a, 0), 1)


def estimate_foreground(image: "np.ndarray", alpha: "np.ndarray") -> "np.ndarray":
    """Blur-fusion foreground colour estimation (Forte & Pitié 2021).

    Pixels with fractional alpha (hair, fur, motion blur) are a mix of subject and old
    background; un-mixing them stops a halo of the old colour appearing on the new one.
    """
    import numpy as np

    a = alpha[..., None]
    fg = image
    bg = image
    for r in (45, 3):  # coarse pass, then fine — the radii from the paper
        blurred_fa = _box_blur(fg * a, r) / (_box_blur(a, r) + 1e-5)
        blurred_b1a = _box_blur(bg * (1 - a), r) / (_box_blur(1 - a, r) + 1e-5)
        fg = np.clip(blurred_fa + a * (image - a * blurred_fa - (1 - a) * blurred_b1a), 0.0, 1.0)
        bg = blurred_b1a
    return fg


def _subject_bbox(alpha: "np.ndarray", padding: int) -> tuple[int, int, int, int] | None:
    """(left, top, right, bottom) of pixels with meaningful alpha, padded and clamped."""
    import numpy as np

    ys, xs = np.nonzero(alpha > 0.05)
    if len(xs) == 0:
        return None
    h, w = alpha.shape
    return (
        max(0, int(xs.min()) - padding),
        max(0, int(ys.min()) - padding),
        min(w, int(xs.max()) + 1 + padding),
        min(h, int(ys.max()) + 1 + padding),
    )


def remove_background(
    img: PilImage, alpha: "np.ndarray", spec: BgRemoveSpec
) -> tuple[bytes, bytes, dict[str, Any]]:
    """Apply a predicted alpha to an image → (encoded image, encoded mask PNG, metadata)."""
    import numpy as np
    from PIL import Image

    if spec.alpha_threshold is not None:
        alpha = (alpha >= spec.alpha_threshold).astype(np.float32)

    rgb = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    fg = estimate_foreground(rgb, alpha) if spec.refine_foreground else rgb

    bbox = _subject_bbox(alpha, spec.padding) if spec.crop else None
    if bbox is not None:
        left, top, right, bottom = bbox
        fg = fg[top:bottom, left:right]
        alpha = alpha[top:bottom, left:right]

    pil_fmt, ext, content_type, _ = _FORMATS[spec.fmt]
    if spec.background is None:
        rgba = np.dstack([fg, alpha])
        out = Image.fromarray((rgba * 255).round().astype(np.uint8), "RGBA")
    else:
        bg = np.array(spec.background, np.float32) / 255.0
        a = alpha[..., None]
        flat = fg * a + bg * (1 - a)
        out = Image.fromarray((flat * 255).round().astype(np.uint8), "RGB")

    kwargs: dict[str, Any] = {}
    if pil_fmt in ("JPEG", "WEBP"):
        kwargs["quality"] = spec.quality if spec.quality is not None else 95
    if pil_fmt == "WEBP" and spec.background is None:
        kwargs["exact"] = True  # keep RGB under transparent pixels intact
    buf = io.BytesIO()
    out.save(buf, format=pil_fmt, **kwargs)

    mask_buf = io.BytesIO()
    Image.fromarray((alpha * 255).round().astype(np.uint8), "L").save(mask_buf, format="PNG")

    meta: dict[str, Any] = {
        "content_type": content_type,
        "extension": ext,
        "width": out.width,
        "height": out.height,
        "original_width": img.width,
        "original_height": img.height,
        "transparent": spec.background is None,
        "subject_bbox": _bbox_dict(bbox) if bbox is not None else _bbox_dict(_subject_bbox(alpha, 0)),
        "foreground_ratio": round(float(alpha.mean()), 4),
    }
    return buf.getvalue(), mask_buf.getvalue(), meta


def _bbox_dict(bbox: tuple[int, int, int, int] | None) -> dict[str, int] | None:
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    return {"x": left, "y": top, "width": right - left, "height": bottom - top}


# --------------------------------------------------------------------------
# executor
# --------------------------------------------------------------------------

def _run(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None,
) -> dict[str, Any]:
    from PIL import Image, ImageOps

    if not output_bucket:
        raise ValueError(f"{capability} requires an 'output_bucket' — results are returned as bucket files")
    if not isinstance(payload, dict):
        raise ValueError(f"{capability} payload must be an object")

    name = registry_name(capability)
    model_spec = MODEL_SPECS.get(name)
    if model_spec is None or name not in ONNX_MODEL_REGISTRY:
        raise ValueError(f"Unknown background-removal model for capability {capability!r}")
    settings = load_agent_settings()
    mfile = model_path(name, settings)
    if mfile is None:
        raise RuntimeError(
            f"Model '{name}' is not installed. Run `omq bgremove install {name}` on the agent "
            f"or slavemode.onnx-models-prepare with name='{name}'"
        )

    spec = BgRemoveSpec.from_payload(payload)
    sources = _select_inputs(payload, data_path)
    cfg = BgRemoveConfig.from_settings(settings)

    report_progress(
        transport,
        log=f"Removing background from {len(sources)} image(s) with {name} (device {cfg.device})\n",
        stage="loading model",
        task_id=task_id,
    )
    sess = _session(mfile, cfg)

    images: list[dict[str, Any]] = []
    for index, source in enumerate(sources, start=1):
        with Image.open(source) as raw:
            img = ImageOps.exif_transpose(raw).convert("RGB")
        alpha = predict_alpha(sess, img, model_spec)
        content, mask, meta = remove_background(img, alpha, spec)

        filename = source.stem + meta.pop("extension")
        file_uid = transport.upload_file(output_bucket, filename, content, meta["content_type"])
        entry: dict[str, Any] = {"filename": filename, **meta, "file_uid": file_uid, "bucket_uid": output_bucket}
        if spec.return_mask:
            mask_name = f"{source.stem}.mask.png"
            entry["mask_filename"] = mask_name
            entry["mask_file_uid"] = transport.upload_file(output_bucket, mask_name, mask, "image/png")
        images.append(entry)

        # Doubles as the cancellation check: the server answers 499 once the client
        # cancels, which report_progress turns into TaskCancelled.
        report_progress(
            transport,
            log=(
                f"[{index}/{len(sources)}] {source.name} {img.width}x{img.height} -> "
                f"{meta['width']}x{meta['height']} {meta['content_type']} "
                f"(subject {meta['foreground_ratio']:.0%} of frame)\n"
            ),
            stage="removing background",
            task_id=task_id,
        )

    return {
        "model": name,
        "format": spec.fmt,
        "background": "transparent" if spec.background is None else "#%02x%02x%02x" % spec.background,
        "image_count": len(images),
        "output_bucket": output_bucket,
        "images": images,
    }


def execute_bgremove(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
    job_timeout: int = 600,
) -> bool:
    """Cut the subject out of every input image and upload the results to the output bucket."""
    try:
        output = _run(transport, task_id, capability, payload, data_path, output_bucket)
        report = make_success_report(task_id, capability, output)
    except TaskCancelled:
        report_cancelled(transport, task_id, capability)
        return True
    except Exception as exc:
        logger.exception("bgremove failed")
        report = make_failure_report(task_id, capability, str(exc))

    return report_result(transport, report)
