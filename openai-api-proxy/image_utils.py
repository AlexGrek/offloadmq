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
# 1120 px is a common sweet-spot for local vision models (LLaVA, BakLLaVA, …).
MAX_DIMENSION = 1120

# JPEG re-encoding quality (1-95). 85 gives a good size/fidelity balance.
JPEG_QUALITY = 85

# If the image is still larger than this after the first resize+encode pass,
# we do a second pass at reduced quality to push it below the limit.
MAX_BYTES_SOFT = 1 * 1024 * 1024   # 1 MB — try harder above this
MAX_BYTES_HARD = 2 * 1024 * 1024   # 2 MB — hard cap (warn and truncate if exceeded)

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
    Decode *b64_data*, resize if needed, re-encode, return (new_b64, new_mime).

    *mime_hint* is used to choose the output format (JPEG vs PNG).
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

        img = _resize(img, MAX_DIMENSION)

        # Choose output format: keep PNG for lossless originals, JPEG otherwise
        use_jpeg = mime_hint not in ("image/png", "image/gif", "image/webp")
        fmt = "JPEG" if use_jpeg else "PNG"
        new_mime = "image/jpeg" if use_jpeg else "image/png"

        encoded = _encode(img, fmt, JPEG_QUALITY)

        # Second pass if still too large: reduce JPEG quality
        if fmt == "JPEG" and len(encoded) > MAX_BYTES_SOFT:
            encoded = _encode(img, fmt, 65)

        # Hard-cap warning (we can't do much more without destroying fidelity)
        if len(encoded) > MAX_BYTES_HARD:
            logger.warning(
                "Image still %.1f KB after compression (hard cap is %d KB); "
                "sending anyway — the agent may reject it.",
                len(encoded) / 1024,
                MAX_BYTES_HARD // 1024,
            )

        new_b64 = base64.b64encode(encoded).decode()

        logger.debug(
            "Image processed: %dx%d -> %dx%d | %.1f KB -> %.1f KB | fmt=%s",
            orig_size[0], orig_size[1],
            img.size[0], img.size[1],
            orig_kb,
            len(encoded) / 1024,
            fmt,
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
