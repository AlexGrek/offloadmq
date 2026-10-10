"""Bridge from the ``slavemode.comfy-ctrl`` executor to core's ComfyUI process manager.

The agent package must not import core, so core registers a handler here at
startup and the executor calls through it (same pattern as ``self_update``).
The handler takes an action from :data:`ACTIONS`, returns a JSON-able status
dict immediately (start/restart do not wait for readiness — the executor polls
``status`` so it can keep reporting progress), and raises ``ValueError`` on
refusal.
"""
from __future__ import annotations

from typing import Any, Callable

ACTIONS = ("start", "stop", "restart", "status")

ComfyControlHandler = Callable[[str], dict[str, Any]]

_handler: ComfyControlHandler | None = None


def set_handler(handler: ComfyControlHandler | None) -> None:
    global _handler
    _handler = handler


def available() -> bool:
    return _handler is not None


def request(action: str) -> dict[str, Any]:
    if _handler is None:
        raise RuntimeError("ComfyUI process control is not available in this process")
    if action not in ACTIONS:
        raise ValueError(f"Unknown action {action!r}; expected one of: {', '.join(ACTIONS)}")
    return _handler(action)
