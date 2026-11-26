"""Where the WorldMirror 2.0 runtime (``world.mirror``) lives, and whether it is usable.

Tencent HY-World 2.0's ``HY-WorldMirror-2.0`` runs in a private venv that
``omq mirror install`` / the GUI builds on demand. Nothing of Tencent's ships with
the agent: code and weights are fetched from their publishers at pinned revisions.
Everything sits under one directory (``mirror_dir``, blank = default)::

    mirror_dir   ~/.offload-agent/mirror
                 ├─ venv/                       python + CUDA torch
                 ├─ src/                        sparse checkout of HY-World-2.0
                 ├─ weights/HY-WorldMirror-2.0/ config.json + model.safetensors (4.7 GiB)
                 ├─ skyseg.onnx                 sky segmentation for the clean-up filters
                 └─ omq-mirror.json             install manifest

**Licence.** The HY-World 2.0 Community License does not apply in the EU, the
United Kingdom or South Korea — code, weights *and generated outputs*. The
capability therefore stays off until the operator accepts that explicitly
(``mirror_license_accepted``).

``offloadmq_core.mirror_install`` builds the runtime; this module only locates it,
cheaply enough for every capability scan (no subprocess, no torch import, no hashing).
"""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from offloadmq_agent.settings_util import load_agent_settings

CODE_REPO = "https://github.com/Tencent-Hunyuan/HY-World-2.0.git"
CODE_REVISION = "df9988efb87bfc0f4947eb3889411cf957478b06"
CODE_SPARSE = "hyworld2/worldrecon"
#: sha256 over hyworld2/**/*.py at CODE_REVISION (relative path + LF-normalised bytes).
CODE_DIGEST = "5b426f45ed7cd8d8015af49967e2a55885ad421537226f9d8694fcc3c6c0beb8"
WEIGHTS_REVISION = "d78a16c91c7a56488894a1c8de4f5c7cc28aa8b0"
WEIGHTS_SUBFOLDER = "HY-WorldMirror-2.0"
SKYSEG_REVISION = "3ba8c6df1d9ba9ff26f637c7ba9568ac11a9aa7f"
_WEIGHTS_URL = f"https://huggingface.co/tencent/HY-World-2.0/resolve/{WEIGHTS_REVISION}/{WEIGHTS_SUBFOLDER}"

LICENSE_URL = "https://github.com/Tencent-Hunyuan/HY-World-2.0/blob/main/License.txt"
LICENSE_NOTICE = (
    "Tencent HY-World 2.0 Community License: it does not apply in the European Union, the United Kingdom "
    "or South Korea, so using the code, the weights or the generated worlds there is unlicensed. "
    "Elsewhere it is royalty-free under an acceptable-use policy."
)
DEFAULT_ROOT = Path.home() / ".offload-agent" / "mirror"
_WINDOWS = sys.platform == "win32"


@dataclass(frozen=True)
class ModelFile:
    #: Path below the runtime directory.
    rel: str
    url: str
    bytes: int
    sha256: str


MODEL_FILES: tuple[ModelFile, ...] = (
    ModelFile(f"weights/{WEIGHTS_SUBFOLDER}/config.json", f"{_WEIGHTS_URL}/config.json", 842,
              "5e40150577ef7d38e24d8d079a7126568a0ec9816dbfc61ebc99c67faf430ed9"),
    ModelFile(f"weights/{WEIGHTS_SUBFOLDER}/model.safetensors", f"{_WEIGHTS_URL}/model.safetensors", 5_053_553_272,
              "9fff06539d3d9e85338d7de1ffb5afffb7739fa5bf4d62b4b7c319b5ecdde54f"),
    ModelFile("skyseg.onnx",
              f"https://huggingface.co/JianyuanWang/skyseg/resolve/{SKYSEG_REVISION}/skyseg.onnx", 175_997_079,
              "ab9c34c64c3d821220a2886a4a06da4642ffa14d5b30e8d5339056a089aa1d39"),
)


@dataclass(frozen=True)
class MirrorPaths:
    root: Path

    @classmethod
    def from_settings(cls, settings: Mapping[str, Any] | None = None) -> MirrorPaths:
        s = load_agent_settings() if settings is None else settings
        text = str(s.get("mirror_dir") or "").strip()
        return cls(root=Path(text).expanduser() if text else DEFAULT_ROOT)

    @property
    def venv(self) -> Path:
        return self.root / "venv"

    @property
    def python(self) -> Path:
        return self.venv / "Scripts" / "python.exe" if _WINDOWS else self.venv / "bin" / "python"

    @property
    def source(self) -> Path:
        return self.root / "src"

    @property
    def pipeline(self) -> Path:
        return self.source / "hyworld2" / "worldrecon" / "pipeline.py"

    @property
    def weights(self) -> Path:
        return self.root / "weights"

    @property
    def manifest(self) -> Path:
        return self.root / "omq-mirror.json"

    def file(self, f: ModelFile) -> Path:
        return self.root / f.rel


def license_accepted(settings: Mapping[str, Any] | None = None) -> bool:
    s = load_agent_settings() if settings is None else settings
    return s.get("mirror_license_accepted") is True


def free_ollama(settings: Mapping[str, Any] | None = None) -> bool:
    """Unload Ollama's models before a run (``mirror_free_ollama``, default on)."""
    s = load_agent_settings() if settings is None else settings
    return s.get("mirror_free_ollama") is not False


@dataclass(frozen=True)
class MirrorStatus:
    paths: MirrorPaths
    license_accepted: bool
    has_venv: bool
    has_code: bool
    has_model: bool
    model_bytes: int
    manifest: dict[str, Any]

    @property
    def installed(self) -> bool:
        """Every piece present and the runtime passed its import check at install time."""
        return self.has_venv and self.has_code and self.has_model and bool(self.manifest)

    @property
    def ready(self) -> bool:
        return self.installed and self.license_accepted

    def describe(self) -> str:
        if not self.license_accepted:
            return "WorldMirror off: the HY-World 2.0 licence is not accepted (`omq mirror config --accept-license`)"
        if self.installed:
            return (f"WorldMirror 2.0, torch {self.manifest.get('torch', '?')} on "
                    f"{self.manifest.get('device') or 'CPU'} ({self.paths.root})")
        missing = [n for n, ok in (("venv", self.has_venv), ("code", self.has_code), ("model", self.has_model),
                                   ("verified install", bool(self.manifest))) if not ok]
        return f"WorldMirror not installed (missing {', '.join(missing)}); run `omq mirror install`"

    def to_dict(self) -> dict[str, Any]:
        return {
            "ready": self.ready,
            "installed": self.installed,
            "license_accepted": self.license_accepted,
            "dir": str(self.paths.root),
            "has_venv": self.has_venv,
            "has_code": self.has_code,
            "has_model": self.has_model,
            "model_bytes": self.model_bytes,
            "manifest": self.manifest,
            "summary": self.describe(),
        }


def status(settings: Mapping[str, Any] | None = None) -> MirrorStatus:
    s = load_agent_settings() if settings is None else settings
    p = MirrorPaths.from_settings(s)
    manifest: dict[str, Any] = {}
    try:
        loaded = json.loads(p.manifest.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            manifest = loaded
    except (OSError, ValueError):
        pass
    sizes = [(p.file(f).stat().st_size if p.file(f).is_file() else 0, f.bytes) for f in MODEL_FILES]
    return MirrorStatus(
        paths=p,
        license_accepted=license_accepted(s),
        has_venv=p.python.is_file(),
        has_code=p.pipeline.is_file(),
        has_model=all(have == want for have, want in sizes),
        model_bytes=sum(have for have, _ in sizes),
        manifest=manifest,
    )
