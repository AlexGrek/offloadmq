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
          scale/WxH              e.g. "scale/1920x1080"
          transcode/FMT          e.g. "transcode/jpeg"
          transcode/FMT[k=v;…]   e.g. "transcode/jpeg[quality=85]"
        """
        if action.startswith("scale/"):
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

        with Image.open(file) as img:
            img = img.convert("RGB") if img.mode not in ("RGB", "RGBA", "L") else img
            img.thumbnail((self.width, self.height), Image.LANCZOS)
            img.save(file)

        logger.info(f"Scaled {file.name} to max {self.width}x{self.height}")


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

        with Image.open(file) as img:
            if pil_fmt == "JPEG" and img.mode in ("RGBA", "P"):
                img = img.convert("RGB")
            img.save(target, format=pil_fmt, **self._save_kwargs())

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
