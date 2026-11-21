"""Where the Apple SHARP runtime lives, and whether it is usable.

SHARP (``apple/ml-sharp``, vendored as the ``agent_v2/third_party/ml-sharp`` git
submodule) needs torch + CUDA, far too heavy for the agent's own environment or
its PyInstaller binary. Nothing is installed with the agent: ``omq sharp
install`` / the GUI's World (SHARP) page builds a private uv venv on demand.
Both locations are agent settings (blank = default)::

    sharp_venv_dir    ~/.offload-agent/sharp/venv     python + torch + `sharp`
                      ├─ omq-src/                      copy of the installed source
                      └─ omq-sharp.json                install manifest
    sharp_models_dir  ~/.offload-agent/sharp/models   sharp_2572gikvuh.pt (2.8 GB)

``offloadmq_core.sharp_install`` builds it; this module only locates it — cheap
enough for every capability scan (no subprocess, no torch import).
"""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from offloadmq_agent.settings_util import load_agent_settings

CHECKPOINT_URL = "https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt"
CHECKPOINT_NAME = "sharp_2572gikvuh.pt"
#: Exact size of the published checkpoint — anything else is a broken download.
CHECKPOINT_BYTES = 2_809_738_232
SUBMODULE_REL = Path("third_party") / "ml-sharp"
#: Directory name of the submodule copy bundled into frozen (PyInstaller) builds.
BUNDLED_NAME = "ml-sharp"
DEFAULT_ROOT = Path.home() / ".offload-agent" / "sharp"
_WINDOWS = sys.platform == "win32"


def _dir(raw: Any, default: Path) -> Path:
    text = str(raw or "").strip()
    return Path(text).expanduser() if text else default


@dataclass(frozen=True)
class SharpPaths:
    venv: Path
    models: Path

    @classmethod
    def from_settings(cls, settings: Mapping[str, Any] | None = None) -> SharpPaths:
        s = load_agent_settings() if settings is None else settings
        return cls(
            venv=_dir(s.get("sharp_venv_dir"), DEFAULT_ROOT / "venv"),
            models=_dir(s.get("sharp_models_dir"), DEFAULT_ROOT / "models"),
        )

    @property
    def python(self) -> Path:
        return self.venv / "Scripts" / "python.exe" if _WINDOWS else self.venv / "bin" / "python"

    @property
    def cli(self) -> Path:
        return self.venv / "Scripts" / "sharp.exe" if _WINDOWS else self.venv / "bin" / "sharp"

    @property
    def checkpoint(self) -> Path:
        return self.models / CHECKPOINT_NAME

    @property
    def source_copy(self) -> Path:
        return self.venv / "omq-src"

    @property
    def manifest(self) -> Path:
        return self.venv / "omq-sharp.json"


def find_source() -> Path | None:
    """The ml-sharp source to install from.

    A frozen build uses the copy PyInstaller bundled; a source checkout walks up
    to ``agent_v2/third_party/ml-sharp`` (the git submodule).
    """
    candidates: list[Path] = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        candidates.append(Path(meipass) / BUNDLED_NAME)
    for parent in Path(__file__).resolve().parents:
        candidates.append(parent / SUBMODULE_REL)
    for c in candidates:
        if (c / "pyproject.toml").is_file() and (c / "src" / "sharp").is_dir():
            return c
    return None


@dataclass(frozen=True)
class SharpStatus:
    paths: SharpPaths
    has_cli: bool
    has_checkpoint: bool
    checkpoint_bytes: int
    manifest: dict[str, Any]

    @property
    def ready(self) -> bool:
        return self.has_cli and self.has_checkpoint

    def describe(self) -> str:
        if self.ready:
            if not self.manifest:
                return f"SHARP present in {self.paths.venv} but unverified; run `omq sharp doctor`"
            rev = str(self.manifest.get("revision") or "")[:8] or "unknown revision"
            dev = self.manifest.get("device") or "CPU"
            return f"SHARP {rev}, torch {self.manifest.get('torch', '?')} on {dev} (venv {self.paths.venv})"
        missing = [n for n, ok in (("venv", self.has_cli), ("model", self.has_checkpoint)) if not ok]
        return f"SHARP not installed (missing {', '.join(missing)}); run `omq sharp install`"

    def to_dict(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "venv_dir": str(self.paths.venv),
            "models_dir": str(self.paths.models),
            "has_venv": self.has_cli,
            "has_model": self.has_checkpoint,
            "model_bytes": self.checkpoint_bytes,
            "manifest": self.manifest,
            "summary": self.describe(),
        }


def status(paths: SharpPaths | None = None) -> SharpStatus:
    p = paths or SharpPaths.from_settings()
    manifest: dict[str, Any] = {}
    try:
        loaded = json.loads(p.manifest.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            manifest = loaded
    except (OSError, ValueError):
        pass
    size = p.checkpoint.stat().st_size if p.checkpoint.is_file() else 0
    return SharpStatus(
        paths=p, has_cli=p.cli.is_file(), has_checkpoint=size == CHECKPOINT_BYTES,
        checkpoint_bytes=size, manifest=manifest,
    )
