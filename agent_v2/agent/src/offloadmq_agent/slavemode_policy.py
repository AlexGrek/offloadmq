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


def strip_slavemode_caps(caps: list[str]) -> list[str]:
    return [c for c in caps if not c.startswith(SLAVEMODE_PREFIX)]


def slavemode_caps_for_registration(cfg: dict[str, Any]) -> list[str]:
    allowed_raw = cfg.get("slavemode_allowed_caps") or cfg.get("slavemode-allowed-caps") or []
    allowed_set = {str(x) for x in allowed_raw}
    return sorted(c for c in ALL_SLAVEMODE_CAPS if c in allowed_set)


def merge_registration_caps(regular_caps: list[str], cfg: dict[str, Any]) -> list[str]:
    return sorted(set(regular_caps) | set(slavemode_caps_for_registration(cfg)))
