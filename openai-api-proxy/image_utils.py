"""
Image pre-processing for vision requests.

Decodes base64-encoded images embedded in messages, resizes them so they
fit within MAX_DIMENSION × MAX_DIMENSION, re-encodes at controlled quality,
and packs them back into the original message structure.

Supports both message formats:
  - OpenAI  : content is a list; items with type="image_url", url="data:…;base64,…"
  - Ollama  : message has an "images" list of raw base64 strings (no data-URI prefix)

Requires Pillow (`pip install Pillow`). If Pillow is absent, images pass through
unchanged with a warning logged once.
"""

import base64
import io
import logging
from typing import Optional

logger = logging.getLogger("openai-proxy.image")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Maximum width or height in pixels after resizing.
# 672 px matches LLaVA 1.5/1.6 tile size and is safe for most Ollama vision
# models. Override via --max-image-dim on the CLI.
MAX_DIMENSION = 672

# JPEG quality sequence used during iterative compression.
# Each step is tried in order until the image fits within MAX_IMAGE_BYTES.
JPEG_QUALITY_STEPS = (85, 70, 55, 40)

# The OffloadMQ server middleware reads request bodies with a hard cap of
# 500 KB (axum::body::to_bytes limit in the auth middleware). The entire
# JSON body — all messages, model name, options, AND all base64 images —
# must fit within that budget. We target well below 500 KB to leave room.
SERVER_BODY_LIMIT = 500_000        # bytes — enforced by the server
IMAGE_BUDGET_PER_REQUEST = 350_000 # bytes — raw binary budget for ALL images combined

# Per-image binary byte cap (base64 adds ~33 % overhead on top).
MAX_IMAGE_BYTES = 180_000          # ~240 KB after base64 encoding

# ---------------------------------------------------------------------------
# PIL availability check (done once at import time)
# ---------------------------------------------------------------------------

try:
    from PIL import Image, ImageOps  # type: ignore

    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False
    logger.warning(
        "Pillow is not installed — images will NOT be resized. "
        "Run: pip install Pillow"
    )


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

def _open_image(raw_bytes: bytes) -> "Image.Image":
    img = Image.open(io.BytesIO(raw_bytes))
    # Handle EXIF rotation so the orientation is baked in before resizing
    img = ImageOps.exif_transpose(img)
    # Animated images: take the first frame only
    if getattr(img, "is_animated", False):
        img.seek(0)
    return img


def _normalise_mode(img: "Image.Image") -> "Image.Image":
    """Convert palette / RGBA / CMYK / etc. to RGB or L."""
    if img.mode in ("RGB", "L"):
        return img
    if img.mode == "RGBA":
        # Composite over white background so transparency becomes white pixels
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        return bg
    return img.convert("RGB")


def _resize(img: "Image.Image", max_dim: int) -> "Image.Image":
    w, h = img.size
    if w <= max_dim and h <= max_dim:
        return img
    scale = min(max_dim / w, max_dim / h)
    new_w = max(1, round(w * scale))
    new_h = max(1, round(h * scale))
    return img.resize((new_w, new_h), Image.LANCZOS)


def _encode(img: "Image.Image", fmt: str, quality: int) -> bytes:
    buf = io.BytesIO()
    if fmt == "JPEG":
        img.save(buf, format="JPEG", quality=quality, optimize=True)
    else:
        img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def process_image_b64(b64_data: str, mime_hint: str = "image/jpeg") -> tuple[str, str]:
    """
    Decode *b64_data*, resize to MAX_DIMENSION, compress to fit within
    MAX_IMAGE_BYTES, re-encode as base64, return (new_b64, new_mime).

    Uses an iterative quality ladder (JPEG_QUALITY_STEPS) and, if quality
    alone is not enough, halves the resolution until the image fits.

    If Pillow is unavailable the original data is returned unchanged.
    """
    if not _PIL_AVAILABLE:
        return b64_data, mime_hint

    try:
        raw = base64.b64decode(b64_data)
        orig_kb = len(raw) / 1024

        img = _open_image(raw)
        img = _normalise_mode(img)
        orig_size = img.size

        # Always resize down to MAX_DIMENSION first
        img = _resize(img, MAX_DIMENSION)

        # Always convert to JPEG (PNG is usually larger; vision models don't
        # care about lossless quality for inference)
        new_mime = "image/jpeg"
        encoded = b""

        # Iterative quality reduction
        for quality in JPEG_QUALITY_STEPS:
            encoded = _encode(img, "JPEG", quality)
            if len(encoded) <= MAX_IMAGE_BYTES:
                break
        else:
            # Quality ladder exhausted — shrink resolution further by halving
            # until the encoded bytes fit or the image becomes trivially small
            shrink_img = img
            while len(encoded) > MAX_IMAGE_BYTES:
                w, h = shrink_img.size
                if min(w, h) <= 64:
                    logger.warning(
                        "Image cannot be reduced below %d×%d while staying "
                        "under %d KB; server may reject the request.",
                        w, h, MAX_IMAGE_BYTES // 1024,
                    )
                    break
                shrink_img = shrink_img.resize(
                    (max(1, w // 2), max(1, h // 2)), Image.LANCZOS
                )
                encoded = _encode(shrink_img, "JPEG", JPEG_QUALITY_STEPS[-1])
            img = shrink_img  # for logging

        new_b64 = base64.b64encode(encoded).decode()

        logger.debug(
            "Image processed: %dx%d -> %dx%d | %.1f KB -> %.1f KB (base64: %.1f KB)",
            orig_size[0], orig_size[1],
            img.size[0], img.size[1],
            orig_kb,
            len(encoded) / 1024,
            len(new_b64) / 1024,
        )
        return new_b64, new_mime

    except Exception:
        logger.exception("Failed to process image; passing through unchanged")
        return b64_data, mime_hint


def parse_data_url(data_url: str) -> tuple[Optional[str], Optional[str]]:
    """
    Parse ``data:<mime>;base64,<data>`` into ``(mime, b64_data)``.
    Returns ``(None, None)`` if the string is not a data URL.
    """
    if not data_url.startswith("data:"):
        return None, None
    rest = data_url[5:]
    if ";base64," not in rest:
        return None, None
    mime, b64 = rest.split(";base64,", 1)
    return mime, b64


def process_messages(messages: list[dict]) -> list[dict]:
    """
    Walk *messages* and resize any embedded images in-place (returns a new list).

    Handles:
    - OpenAI format : ``content`` is a list with ``{"type": "image_url", "image_url": {"url": "data:…"}}``
    - Ollama format : ``images`` is a list of raw base64 strings
    """
    if not messages:
        return messages

    result: list[dict] = []
    for msg in messages:
        msg = dict(msg)  # shallow copy — don't mutate caller's dict

        # ---- OpenAI content-array format ------------------------------------
        content = msg.get("content")
        if isinstance(content, list):
            new_content: list[dict] = []
            for part in content:
                part = dict(part)
                if part.get("type") == "image_url":
                    url_field = part.get("image_url", {})
                    # url_field may be a dict {"url": "..."} or a plain string
                    if isinstance(url_field, dict):
                        raw_url = url_field.get("url", "")
                    else:
                        raw_url = str(url_field)

                    mime, b64 = parse_data_url(raw_url)
                    if mime and b64:
                        new_b64, new_mime = process_image_b64(b64, mime)
                        new_url = f"data:{new_mime};base64,{new_b64}"
                        if isinstance(url_field, dict):
                            part["image_url"] = {**url_field, "url": new_url}
                        else:
                            part["image_url"] = new_url
                new_content.append(part)
            msg["content"] = new_content

        # ---- Ollama images list ---------------------------------------------
        images = msg.get("images")
        if isinstance(images, list):
            msg["images"] = [process_image_b64(img)[0] for img in images]

        result.append(msg)

    return result
