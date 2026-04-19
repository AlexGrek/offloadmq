"""Pre-processing transformations applied to downloaded input files before executor runs."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

import logging

logger = logging.getLogger(__name__)


class DataPreparation(ABC):
    def __init__(self, pattern: str) -> None:
        self.pattern = pattern

    @abstractmethod
    def apply(self, file: Path) -> None:
        ...

    @classmethod
    def parse(cls, pattern: str, action: str) -> "DataPreparation":
        """Parse an action string into a concrete DataPreparation instance.

        Supported formats:
          scale/WxH                     e.g. "scale/1920x1080"
          scale/max[px=N,mp=N]          e.g. "scale/max[px=1920,mp=12]"
          transcode/FMT                  e.g. "transcode/jpeg"
          transcode/FMT[k=v;…]           e.g. "transcode/jpeg[quality=85]"
        """
        if action.startswith("scale/"):
            body = action[len("scale/"):]
            if body.startswith("max"):
                return ScaleMaxPreparation.from_action(pattern, action)
            return ScalePreparation.from_action(pattern, action)
        if action.startswith("transcode/"):
            return TranscodePreparation.from_action(pattern, action)
        raise ValueError(f"Unknown data_preparation action: {action!r}")


class ScalePreparation(DataPreparation):
    """Resize images to a target resolution using Pillow.

    Maintains aspect ratio when only one dimension differs; exact crop/pad
    behaviour is not applied — images are resized to fit within WxH using
    LANCZOS resampling.
    """

    def __init__(self, pattern: str, width: int, height: int) -> None:
        super().__init__(pattern)
        self.width = width
        self.height = height

    @classmethod
    def from_action(cls, pattern: str, action: str) -> "ScalePreparation":
        m = re.fullmatch(r"scale/(\d+)x(\d+)", action)
        if not m:
            raise ValueError(f"Invalid scale action (expected scale/WxH): {action!r}")
        return cls(pattern, int(m.group(1)), int(m.group(2)))

    def apply(self, file: Path) -> None:
        from PIL import Image

        with Image.open(file) as raw:
            out: Image.Image = raw.convert("RGB") if raw.mode not in ("RGB", "RGBA", "L") else raw.copy()
            out.thumbnail((self.width, self.height), Image.Resampling.LANCZOS)
            out.save(file)

        logger.info(f"Scaled {file.name} to max {self.width}x{self.height}")


class ScaleMaxPreparation(DataPreparation):
    """Resize images so that all supplied constraints are satisfied simultaneously.

    Constraints (all optional, at least one required):
      px=N   — neither dimension may exceed N pixels
      mp=N   — total pixel count (W×H) may not exceed N megapixels

    The most restrictive constraint wins. Images that already satisfy every
    constraint are left untouched (never upscaled). Aspect ratio is preserved.

    Action format:  scale/max[px=1920,mp=12]
    """

    def __init__(self, pattern: str, px: int | None, mp: float | None) -> None:
        super().__init__(pattern)
        self.px = px    # max pixels per side
        self.mp = mp    # max megapixels total

    @classmethod
    def from_action(cls, pattern: str, action: str) -> "ScaleMaxPreparation":
        m = re.fullmatch(r"scale/max(?:\[([^\]]*)\])?", action)
        if not m:
            raise ValueError(f"Invalid scale/max action: {action!r}")
        px: int | None = None
        mp: float | None = None
        if m.group(1):
            for pair in re.split(r"[,;]", m.group(1)):
                pair = pair.strip()
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    k = k.strip()
                    if k == "px":
                        px = int(v.strip())
                    elif k == "mp":
                        mp = float(v.strip())
        if px is None and mp is None:
            raise ValueError(f"scale/max requires at least one of px= or mp=: {action!r}")
        return cls(pattern, px, mp)

    def _scale_factor(self, orig_w: int, orig_h: int) -> float:
        scale = 1.0
        if self.px is not None:
            scale = min(scale, self.px / orig_w, self.px / orig_h)
        if self.mp is not None:
            mp_limit = self.mp * 1_000_000
            total = orig_w * orig_h
            if total > mp_limit:
                scale = min(scale, (mp_limit / total) ** 0.5)
        return scale

    def apply(self, file: Path) -> None:
        from PIL import Image

        with Image.open(file) as src:
            orig_w, orig_h = src.size
            scale = self._scale_factor(orig_w, orig_h)
            if scale >= 1.0:
                logger.info(f"scale/max: {file.name} already within constraints, skipping")
                return
            new_w = max(1, round(orig_w * scale))
            new_h = max(1, round(orig_h * scale))
            image: Image.Image = (
                src.convert("RGB")
                if src.mode not in ("RGB", "RGBA", "L")
                else src.copy()
            )
            image = image.resize((new_w, new_h), Image.Resampling.LANCZOS)
            image.save(file)

        logger.info(
            f"scale/max: {file.name} {orig_w}x{orig_h} → {new_w}x{new_h} "
            f"(scale={scale:.4f}, px={self.px}, mp={self.mp})"
        )


class TranscodePreparation(DataPreparation):
    """Convert image files to a different format using Pillow.

    The original file is replaced; if the format implies a different extension
    (e.g. jpeg → .jpg), the file is renamed and the original removed.

    Options are format-specific keyword arguments forwarded to Pillow's save():
      quality=85   → JPEG quality
      optimize=1   → enable optimizer
    """

    _FORMAT_EXTENSIONS: dict[str, str] = {
        "jpeg": ".jpg",
        "jpg": ".jpg",
        "png": ".png",
        "webp": ".webp",
        "gif": ".gif",
        "bmp": ".bmp",
        "tiff": ".tiff",
    }

    def __init__(self, pattern: str, fmt: str, options: dict[str, str]) -> None:
        super().__init__(pattern)
        self.fmt = fmt.lower()
        self.options = options

    @classmethod
    def from_action(cls, pattern: str, action: str) -> "TranscodePreparation":
        m = re.fullmatch(r"transcode/([a-zA-Z0-9]+)(?:\[([^\]]*)\])?", action)
        if not m:
            raise ValueError(f"Invalid transcode action: {action!r}")
        fmt = m.group(1).lower()
        opts: dict[str, str] = {}
        if m.group(2):
            for pair in m.group(2).split(";"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    opts[k.strip()] = v.strip()
        return cls(pattern, fmt, opts)

    def _save_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        for k, v in self.options.items():
            if k == "quality":
                kwargs["quality"] = int(v)
            elif k == "optimize":
                kwargs["optimize"] = bool(int(v))
            elif k == "lossless":
                kwargs["lossless"] = bool(int(v))
            else:
                kwargs[k] = v
        return kwargs

    def apply(self, file: Path) -> None:
        from PIL import Image

        pil_fmt = "JPEG" if self.fmt in ("jpeg", "jpg") else self.fmt.upper()
        ext = self._FORMAT_EXTENSIONS.get(self.fmt, f".{self.fmt}")
        target = file.with_suffix(ext)

        with Image.open(file) as src:
            work: Image.Image
            if pil_fmt == "JPEG" and src.mode in ("RGBA", "P"):
                work = src.convert("RGB")
            else:
                work = src
            work.save(target, format=pil_fmt, **self._save_kwargs())

        if target != file:
            file.unlink()

        logger.info(f"Transcoded {file.name} → {target.name} (fmt={pil_fmt}, opts={self.options})")


def apply_data_preparation(data_path: Path, rules: dict[str, str]) -> None:
    """Apply all data preparation rules to files directly inside data_path."""
    files = [f for f in data_path.iterdir() if f.is_file()]
    for file in files:
        for mask, action in rules.items():
            if fnmatch(file.name, mask):
                prep = DataPreparation.parse(mask, action)
                prep.apply(file)
                break  # one rule per file
