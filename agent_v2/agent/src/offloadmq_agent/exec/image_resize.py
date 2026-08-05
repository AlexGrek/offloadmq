"""image_resize executor — plain Pillow image rescaling, no external runtime.

Every other image capability on the agent is gated on something the operator has to
install (ComfyUI, a workflow directory, a model).  ``image_resize`` deliberately is
not: Pillow is a hard dependency of the agent, so the capability is always detected
and every agent advertises it by default.  That makes it the cheap fallback for
clients that only need to change an image's dimensions and should never occupy a GPU
node to do it.

The supported resampling filters are published as the capability's extended
attributes — ``image_resize[nearest;box;bilinear;hamming;bicubic;lanczos]`` — so a
client can pick a filter knowing the agent implements it.

See docs/image-resize-api.md for the payload contract.
"""

from __future__ import annotations

import io
import logging
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
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.wire import TaskId

if TYPE_CHECKING:
    from PIL.Image import Image as PilImage

logger = logging.getLogger("agent")

CAPABILITY = "image_resize"

# Pillow resampling filters, in quality/cost order. Published as the capability's
# extended attributes, so this tuple is the single source of truth for both the
# registration string and payload validation.
RESAMPLING_METHODS: tuple[str, ...] = (
    "nearest",
    "box",
    "bilinear",
    "hamming",
    "bicubic",
    "lanczos",
)
DEFAULT_METHOD = "lanczos"

# How the target box is interpreted:
#   fit   — largest size that fits inside the box, aspect preserved
#   exact — stretched to exactly width x height, aspect ignored
#   cover — fills the box and centre-crops the overflow, aspect preserved
RESIZE_MODES: tuple[str, ...] = ("fit", "exact", "cover")
DEFAULT_MODE = "fit"

# name → (Pillow format, extension, content type)
_FORMATS: dict[str, tuple[str, str, str]] = {
    "png": ("PNG", ".png", "image/png"),
    "jpeg": ("JPEG", ".jpg", "image/jpeg"),
    "jpg": ("JPEG", ".jpg", "image/jpeg"),
    "webp": ("WEBP", ".webp", "image/webp"),
    "bmp": ("BMP", ".bmp", "image/bmp"),
    "tiff": ("TIFF", ".tiff", "image/tiff"),
    "gif": ("GIF", ".gif", "image/gif"),
}

# Pillow format → (extension, content type), for when the output format is inherited
# from the input rather than named in the payload.
_FORMAT_BY_PIL: dict[str, tuple[str, str]] = {
    pil: (ext, ct) for pil, ext, ct in _FORMATS.values()
}

_IMAGE_SUFFIXES = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}
)


def capability_string() -> str:
    """The registration string, filters included: ``image_resize[nearest;box;…]``."""
    return f"{CAPABILITY}[{';'.join(RESAMPLING_METHODS)}]"


@dataclass(frozen=True)
class ResizeSpec:
    method: str
    mode: str
    width: int | None
    height: int | None
    scale: float | None
    allow_upscale: bool
    fmt: str | None  # payload-requested format name; None = keep the input's
    quality: int | None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ResizeSpec":
        method = str(payload.get("method") or DEFAULT_METHOD).lower()
        if method not in RESAMPLING_METHODS:
            raise ValueError(
                f"Unsupported method {method!r} — supported: {', '.join(RESAMPLING_METHODS)}"
            )

        mode = str(payload.get("mode") or DEFAULT_MODE).lower()
        if mode not in RESIZE_MODES:
            raise ValueError(
                f"Unsupported mode {mode!r} — supported: {', '.join(RESIZE_MODES)}"
            )

        width = _opt_dimension(payload.get("width"), "width")
        height = _opt_dimension(payload.get("height"), "height")
        scale = _opt_scale(payload.get("scale"))

        if scale is None and width is None and height is None:
            raise ValueError(
                "Nothing to resize to — supply 'scale', or 'width' and/or 'height'"
            )
        if scale is None and mode in ("exact", "cover") and (width is None or height is None):
            raise ValueError(f"mode={mode!r} requires both 'width' and 'height'")

        fmt = payload.get("format")
        fmt_name = str(fmt).lower() if fmt else None
        if fmt_name is not None and fmt_name not in _FORMATS:
            raise ValueError(
                f"Unsupported format {fmt_name!r} — supported: {', '.join(sorted(_FORMATS))}"
            )

        quality = payload.get("quality")
        quality_val = int(quality) if quality is not None else None
        if quality_val is not None and not 1 <= quality_val <= 100:
            raise ValueError(f"quality must be between 1 and 100, got {quality_val}")

        return cls(
            method=method,
            mode=mode,
            width=width,
            height=height,
            scale=scale,
            allow_upscale=bool(payload.get("allow_upscale", True)),
            fmt=fmt_name,
            quality=quality_val,
        )

    def target_size(self, src_w: int, src_h: int) -> tuple[int, int]:
        """Resolve the output size for one source image."""
        if self.scale is not None:
            return _clamp(src_w * self.scale), _clamp(src_h * self.scale)

        if self.mode in ("exact", "cover"):
            # from_payload guarantees both are set for these modes.
            assert self.width is not None and self.height is not None
            return self.width, self.height

        factors = []
        if self.width is not None:
            factors.append(self.width / src_w)
        if self.height is not None:
            factors.append(self.height / src_h)
        factor = min(factors)
        if not self.allow_upscale:
            factor = min(factor, 1.0)
        return _clamp(src_w * factor), _clamp(src_h * factor)


def _clamp(value: float) -> int:
    return max(1, round(value))


def _opt_dimension(raw: Any, field: str) -> int | None:
    if raw is None:
        return None
    value = int(raw)
    if value < 1:
        raise ValueError(f"'{field}' must be a positive integer, got {value}")
    return value


def _opt_scale(raw: Any) -> float | None:
    if raw is None:
        return None
    value = float(raw)
    if value <= 0:
        raise ValueError(f"'scale' must be greater than 0, got {value}")
    return value


def _resampling(method: str) -> Any:
    from PIL import Image

    return getattr(Image.Resampling, method.upper())


def _select_inputs(payload: dict[str, Any], data_path: Path) -> list[Path]:
    """Resolve the images to process — named in the payload, or every image in the bucket."""
    named = payload.get("input_image")
    if named is None:
        named = payload.get("input_images")

    if isinstance(named, str):
        names = [named]
    elif isinstance(named, list):
        names = [str(n) for n in named]
    else:
        names = []

    if names:
        root = data_path.resolve()
        files: list[Path] = []
        for name in names:
            candidate = (data_path / name).resolve()
            # A bucket filename is client-controlled; keep it inside the task directory.
            if not candidate.is_relative_to(root):
                raise ValueError(f"Input image {name!r} escapes the task directory")
            if not candidate.is_file():
                raise FileNotFoundError(
                    f"Input image {name!r} was not found in the task's file bucket"
                )
            files.append(candidate)
        return files

    files = sorted(
        p
        for p in data_path.iterdir()
        if p.is_file() and p.suffix.lower() in _IMAGE_SUFFIXES
    )
    if not files:
        raise ValueError(
            "No input images found — upload images to a bucket and pass it as 'file_bucket', "
            "or name them with 'input_image'"
        )
    return files


def _output_format(spec: ResizeSpec, source_format: str | None) -> tuple[str, str, str]:
    """Return (pillow format, extension, content type) for the output file."""
    if spec.fmt is not None:
        return _FORMATS[spec.fmt]
    if source_format and source_format.upper() in _FORMAT_BY_PIL:
        ext, ct = _FORMAT_BY_PIL[source_format.upper()]
        return source_format.upper(), ext, ct
    # Unknown/exotic input format — PNG is the safe lossless default.
    return _FORMATS["png"]


def _encode(image: PilImage, pil_fmt: str, quality: int | None) -> bytes:
    from PIL import Image

    work = image
    if pil_fmt in ("JPEG", "BMP") and work.mode in ("RGBA", "LA", "P"):
        work = work.convert("RGB")
    elif pil_fmt == "GIF" and work.mode not in ("P", "L"):
        work = work.convert("P", palette=Image.Palette.ADAPTIVE)

    kwargs: dict[str, Any] = {}
    if quality is not None and pil_fmt in ("JPEG", "WEBP"):
        kwargs["quality"] = quality

    buf = io.BytesIO()
    work.save(buf, format=pil_fmt, **kwargs)
    return buf.getvalue()


def _resize_one(source: Path, spec: ResizeSpec) -> tuple[bytes, dict[str, Any]]:
    """Resize a single file and return its encoded bytes plus a metadata dict."""
    from PIL import Image, ImageOps

    with Image.open(source) as raw:
        source_format = raw.format
        # Apply EXIF orientation first, so the geometry below matches what a viewer shows.
        image = ImageOps.exif_transpose(raw)
        src_w, src_h = image.size
        target_w, target_h = spec.target_size(src_w, src_h)
        resample = _resampling(spec.method)

        if spec.mode == "cover" and spec.scale is None:
            out: PilImage = ImageOps.fit(
                image, (target_w, target_h), method=resample
            )
        else:
            out = image.resize((target_w, target_h), resample)

        pil_fmt, ext, content_type = _output_format(spec, source_format)
        content = _encode(out, pil_fmt, spec.quality)

    meta = {
        "filename": source.stem + ext,
        "content_type": content_type,
        "width": out.width,
        "height": out.height,
        "original_width": src_w,
        "original_height": src_h,
    }
    return content, meta


def _run(
    transport: AgentTransport,
    task_id: TaskId,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None,
) -> dict[str, Any]:
    if not output_bucket:
        raise ValueError(
            "image_resize requires an 'output_bucket' — results are returned as bucket files"
        )
    if not isinstance(payload, dict):
        raise ValueError("image_resize payload must be an object")

    spec = ResizeSpec.from_payload(payload)
    sources = _select_inputs(payload, data_path)

    report_progress(
        transport,
        log=f"Resizing {len(sources)} image(s) with method={spec.method} mode={spec.mode}\n",
        stage="resizing",
        task_id=task_id,
    )

    images: list[dict[str, Any]] = []
    for index, source in enumerate(sources, start=1):
        content, meta = _resize_one(source, spec)
        file_uid = transport.upload_file(
            output_bucket, meta["filename"], content, meta["content_type"]
        )
        images.append({**meta, "file_uid": file_uid, "bucket_uid": output_bucket})
        # Doubles as the cancellation check: the server answers 499 once the client
        # cancels, which report_progress turns into TaskCancelled.
        report_progress(
            transport,
            log=(
                f"[{index}/{len(sources)}] {source.name} "
                f"{meta['original_width']}x{meta['original_height']} -> "
                f"{meta['width']}x{meta['height']} ({len(content)} bytes, {meta['content_type']})\n"
            ),
            stage="resizing",
            task_id=task_id,
        )

    return {
        "method": spec.method,
        "mode": spec.mode,
        "image_count": len(images),
        "output_bucket": output_bucket,
        "images": images,
    }


def execute_image_resize(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
    job_timeout: int = 600,
) -> bool:
    """Resize the task's input images with Pillow and upload them to the output bucket."""
    try:
        output = _run(transport, task_id, payload, data_path, output_bucket)
        report = make_success_report(task_id, capability, output)
    except TaskCancelled:
        report_cancelled(transport, task_id, capability)
        return True
    except Exception as exc:
        logger.exception("image_resize failed")
        report = make_failure_report(task_id, capability, str(exc))

    return report_result(transport, report)
