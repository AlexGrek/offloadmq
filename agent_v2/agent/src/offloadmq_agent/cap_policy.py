"""3-tier capability policy for registration."""
from __future__ import annotations

import logging
from typing import Any, Callable

from offloadmq_agent.slavemode_policy import merge_registration_caps, strip_slavemode_caps

logger = logging.getLogger(__name__)

_OLLAMA_SLAVEMODE_DEFAULTS = [
    "slavemode.ollama-delete",
    "slavemode.ollama-list",
    "slavemode.ollama-pull",
]

_ONNX_SLAVEMODE_DEFAULTS = [
    "slavemode.onnx-models-delete",
    "slavemode.onnx-models-list",
    "slavemode.onnx-models-prepare",
]


def _cfg_list(cfg: dict[str, Any], *keys: str) -> list[str]:
    for key in keys:
        val = cfg.get(key)
        if isinstance(val, list):
            return [str(x) for x in val]
    return []


def is_sensitive_capability(cap: str) -> bool:
    prefixes = ("docker.", "shell.", "shellcmd.")
    return any(cap.startswith(p) for p in prefixes)


def is_regular_capability(cap: str) -> bool:
    prefixes = ("llm.", "imggen.", "txt2music.", "tts.", "debug.", "custom.", "onnx.")
    return any(cap.startswith(p) for p in prefixes)


def classify_capabilities(caps: list[str]) -> dict[str, list[str]]:
    regular: list[str] = []
    sensitive: list[str] = []
    unknown: list[str] = []
    for cap in caps:
        if is_sensitive_capability(cap):
            sensitive.append(cap)
        elif is_regular_capability(cap):
            regular.append(cap)
        else:
            unknown.append(cap)
    return {"regular": regular, "sensitive": sensitive, "unknown": unknown}


def _apply_default_ollama_slavemode(
    cfg: dict[str, Any],
    detected_caps: list[str],
    log_fn: Callable[[str], None] | None = None,
) -> bool:
    if _cfg_list(cfg, "slavemode_allowed_caps", "slavemode-allowed-caps"):
        return False
    if not any(c.startswith("llm.") for c in detected_caps):
        return False
    cfg["slavemode_allowed_caps"] = sorted(_OLLAMA_SLAVEMODE_DEFAULTS)
    if log_fn:
        log_fn("[caps] Auto-enabled Ollama slavemode caps (first launch with Ollama)")
    return True


def _apply_default_onnx_slavemode(
    cfg: dict[str, Any],
    detected_caps: list[str],
    log_fn: Callable[[str], None] | None = None,
) -> bool:
    if cfg.get("onnx_slavemode_initialized") or cfg.get("_onnx_slavemode_initialized"):
        return False
    has_onnx_cap = any(c.startswith("onnx.") for c in detected_caps)
    has_onnx_runtime = False
    if not has_onnx_cap:
        try:
            import onnxruntime  # noqa: F401

            has_onnx_runtime = True
        except ImportError:
            has_onnx_runtime = False
    if not has_onnx_cap and not has_onnx_runtime:
        return False
    existing = _cfg_list(cfg, "slavemode_allowed_caps", "slavemode-allowed-caps")
    cfg["slavemode_allowed_caps"] = sorted(set(existing + _ONNX_SLAVEMODE_DEFAULTS))
    cfg["onnx_slavemode_initialized"] = True
    if log_fn:
        log_fn("[caps] Auto-enabled ONNX slavemode caps")
    return True


def _migrate_legacy_config(
    cfg: dict[str, Any],
    detected_clean: list[str],
    log_fn: Callable[[str], None] | None = None,
) -> None:
    saved = cfg.get("capabilities", [])
    saved_set = set(strip_slavemode_caps(list(saved) if isinstance(saved, list) else []))
    classified = classify_capabilities(detected_clean)
    detected_regular = set(classified["regular"])
    detected_sensitive = set(classified["sensitive"])
    sensitive_allowed = [c for c in detected_sensitive if c in saved_set]
    regular_disabled = [c for c in detected_regular if c not in saved_set]
    cfg["sensitive_allowed_caps"] = sorted(sensitive_allowed)
    cfg["regular_disabled_caps"] = sorted(regular_disabled)
    if log_fn:
        log_fn("[caps] Migrated legacy config to tier-based format")


def compute_registration_caps(
    cfg: dict[str, Any],
    detected: list[str],
    log_fn: Callable[[str], None] | None = None,
) -> list[str]:
    detected_clean = strip_slavemode_caps(list(detected))
    detected_set = set(detected_clean)

    changed = _apply_default_ollama_slavemode(cfg, detected_clean, log_fn)
    changed = _apply_default_onnx_slavemode(cfg, detected_clean, log_fn) or changed

    classified = classify_capabilities(detected_clean)
    detected_regular = set(classified["regular"])
    detected_sensitive = set(classified["sensitive"])
    detected_unknown = set(classified["unknown"])

    caps_field = cfg.get("capabilities")
    if isinstance(caps_field, list) and not _cfg_list(
        cfg, "sensitive_allowed_caps", "sensitive-allowed-caps"
    ):
        _migrate_legacy_config(cfg, detected_clean, log_fn)
        changed = True

    sensitive_allowed = set(
        _cfg_list(cfg, "sensitive_allowed_caps", "sensitive-allowed-caps")
    )
    sensitive_enabled = [c for c in detected_sensitive if c in sensitive_allowed]

    regular_disabled = set(
        _cfg_list(cfg, "regular_disabled_caps", "regular-disabled-caps")
    )
    regular_enabled = [c for c in detected_regular if c not in regular_disabled]
    unknown_enabled = [c for c in detected_unknown if c not in regular_disabled]

    if log_fn:
        for cap in sensitive_allowed:
            if cap not in detected_set:
                log_fn(f"[caps] WARNING: allowed sensitive '{cap}' not detected")
        missing_disabled = regular_disabled - detected_set
        if missing_disabled:
            log_fn(
                f"[caps] NOTE: {len(missing_disabled)} disabled cap(s) not detected"
            )

    caps = regular_enabled + sensitive_enabled + unknown_enabled
    return merge_registration_caps(caps, cfg)
