"""Where the onnx.bgremove.* models live, what runs them, and whether they are usable.

Nothing is downloaded with the agent: ``omq bgremove install`` / the GUI's
Background removal page / ``slavemode.onnx-models-prepare`` fetch the models
into the shared ONNX directory. All knobs are agent settings::

    onnx_models_dir        ~/.offload-agent/onnx-models   shared with onnx.nudenet
    bgremove_device        auto | cuda | directml | cpu   onnxruntime execution provider
    bgremove_threads       0 = onnxruntime default        CPU intra-op threads
    bgremove_keep_loaded   true                           keep sessions in RAM between tasks

``offloadmq_core.bgremove_install`` installs / verifies / removes models; this
module only locates them and resolves the device — cheap enough for every
capability scan (no onnxruntime session, no hashing).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from offloadmq_agent.onnx_models import ONNX_MODEL_REGISTRY, list_models, models_dir
from offloadmq_agent.settings_util import load_agent_settings

MODEL_PREFIX = "bgremove-"
DEFAULT_MODEL = "bgremove-birefnet-general"

CPU = "CPUExecutionProvider"
_DEVICE_PROVIDERS: dict[str, str] = {
    "cuda": "CUDAExecutionProvider",
    "directml": "DmlExecutionProvider",
    "cpu": CPU,
}
DEVICE_CHOICES = ("auto", *_DEVICE_PROVIDERS)
#: ``auto`` takes the first of these the onnxruntime build provides.
AUTO_PREFERENCE = ("CUDAExecutionProvider", "DmlExecutionProvider", CPU)


class BgRemoveConfigError(ValueError):
    pass


def validate_device(choice: str | None) -> str:
    device = (choice or "auto").strip().lower()
    if device not in DEVICE_CHOICES:
        raise BgRemoveConfigError(
            f"bgremove_device must be one of {', '.join(DEVICE_CHOICES)}, got {choice!r}"
        )
    return device


def resolve_providers(device: str, available: Sequence[str]) -> list[str]:
    """Execution providers for a session, best first.

    ``auto`` never fails (falls back to CPU). An explicit GPU device fails when
    this onnxruntime build lacks it — silently running a "cuda" agent on CPU
    would make tasks 20× slower with no hint why. CPU stays as the fallback
    for operators the GPU provider does not implement.
    """
    device = validate_device(device)
    have = set(available)
    if device == "auto":
        return [p for p in AUTO_PREFERENCE if p in have] or [CPU]
    wanted = _DEVICE_PROVIDERS[device]
    if wanted not in have:
        raise BgRemoveConfigError(
            f"bgremove_device is '{device}' but this onnxruntime build only provides "
            f"{', '.join(sorted(have)) or 'nothing'}; install the matching onnxruntime "
            f"package or set the device to auto/cpu"
        )
    return [wanted] if wanted == CPU else [wanted, CPU]


def available_providers() -> list[str] | None:
    """Providers of the installed onnxruntime, or None when it is not importable."""
    try:
        import onnxruntime as ort
    except ImportError:
        return None
    return list(ort.get_available_providers())


def onnxruntime_version() -> str | None:
    try:
        import onnxruntime as ort
    except ImportError:
        return None
    return str(ort.__version__)


@dataclass(frozen=True)
class BgRemoveConfig:
    device: str
    threads: int
    keep_loaded: bool

    @classmethod
    def from_settings(cls, settings: Mapping[str, Any] | None = None) -> BgRemoveConfig:
        s = load_agent_settings() if settings is None else settings
        try:
            threads = max(0, int(s.get("bgremove_threads") or 0))
        except (TypeError, ValueError):
            threads = 0
        keep = s.get("bgremove_keep_loaded")
        return cls(
            device=str(s.get("bgremove_device") or "auto").strip().lower(),
            threads=threads,
            keep_loaded=True if keep is None else bool(keep),
        )


def model_names() -> list[str]:
    return [n for n in ONNX_MODEL_REGISTRY if n.startswith(MODEL_PREFIX)]


def normalize_model(name: str) -> str:
    """``birefnet-general`` / ``bgremove-birefnet-general`` / the capability → registry name."""
    raw = name.strip()
    if raw.startswith("onnx.bgremove."):
        raw = raw[len("onnx.bgremove."):].split("[", 1)[0]
    full = raw if raw.startswith(MODEL_PREFIX) else MODEL_PREFIX + raw
    if full not in ONNX_MODEL_REGISTRY:
        short = ", ".join(n[len(MODEL_PREFIX):] for n in model_names())
        raise BgRemoveConfigError(f"unknown background-removal model {name!r} (known: {short})")
    return full


def short_name(name: str) -> str:
    return name[len(MODEL_PREFIX):] if name.startswith(MODEL_PREFIX) else name


def status(settings: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Installed models + device resolution. Never hashes or loads a model."""
    s = load_agent_settings() if settings is None else settings
    cfg = BgRemoveConfig.from_settings(s)
    models: list[dict[str, Any]] = []
    for m in list_models(s):
        if not m["name"].startswith(MODEL_PREFIX):
            continue
        expected = m.get("expected_bytes")
        size = int(m.get("size_bytes") or 0)
        complete = m["installed"] and (not expected or size == expected)
        models.append({
            "name": m["name"],
            "short": short_name(m["name"]),
            "capability": m["capability"],
            "description": m["description"],
            "filename": m["filename"],
            "installed": bool(complete),
            "present": bool(m["installed"]),  # file exists, maybe truncated
            "size_bytes": size,
            "expected_bytes": expected,
            "default": m["name"] == DEFAULT_MODEL,
        })

    available = available_providers()
    providers: list[str] = []
    device_error: str | None = None
    if available is None:
        device_error = "onnxruntime is not installed in this agent build"
    else:
        try:
            providers = resolve_providers(cfg.device, available)
        except BgRemoveConfigError as exc:
            device_error = str(exc)

    installed = [m["short"] for m in models if m["installed"]]
    ready = bool(installed) and device_error is None
    if device_error:
        summary = f"Background removal unavailable: {device_error}"
    elif installed:
        summary = f"{len(installed)} model(s) ready ({', '.join(installed)}) on {providers[0]}"
    else:
        summary = "No background-removal model installed; run `omq bgremove install`"
    return {
        "ready": ready,
        "summary": summary,
        "models_dir": str(models_dir(s)),
        "models": models,
        "device": cfg.device,
        "threads": cfg.threads,
        "keep_loaded": cfg.keep_loaded,
        "onnxruntime": onnxruntime_version(),
        "available_providers": available or [],
        "providers": providers,
        "device_error": device_error,
    }
