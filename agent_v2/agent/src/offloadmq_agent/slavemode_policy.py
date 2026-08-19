"""Slavemode capability allow-list policy (no executors)."""
from __future__ import annotations

from typing import Any

ALL_SLAVEMODE_CAPS: list[str] = [
    "slavemode.force-rescan",
    "slavemode.ollama-delete",
    "slavemode.ollama-list",
    "slavemode.ollama-pull",
    "slavemode.onnx-models-delete",
    "slavemode.onnx-models-list",
    "slavemode.onnx-models-prepare",
    "slavemode.special-caps-ctrl",
]

SLAVEMODE_PREFIX = "slavemode."

# v2 settings key. The hyphenated spelling is the legacy offload-agent name and is
# still honoured on read so imported v1 configs keep working.
CONFIG_KEY = "slavemode_allowed_caps"
LEGACY_CONFIG_KEY = "slavemode-allowed-caps"


def strip_slavemode_caps(caps: list[str]) -> list[str]:
    return [c for c in caps if not c.startswith(SLAVEMODE_PREFIX)]


def allowed_caps(cfg: dict[str, Any]) -> set[str]:
    """The operator's slavemode allow-list, read from either key spelling."""
    allowed_raw = cfg.get(CONFIG_KEY) or cfg.get(LEGACY_CONFIG_KEY) or []
    return {str(x) for x in allowed_raw}


def is_cap_allowed(cfg: dict[str, Any], capability: str) -> bool:
    """True only if `capability` is implemented *and* explicitly allow-listed."""
    return capability in ALL_SLAVEMODE_CAPS and capability in allowed_caps(cfg)


def slavemode_caps_for_registration(cfg: dict[str, Any]) -> list[str]:
    allowed_set = allowed_caps(cfg)
    return sorted(c for c in ALL_SLAVEMODE_CAPS if c in allowed_set)


def merge_registration_caps(regular_caps: list[str], cfg: dict[str, Any]) -> list[str]:
    return sorted(set(regular_caps) | set(slavemode_caps_for_registration(cfg)))
