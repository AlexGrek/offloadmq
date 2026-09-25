"""Bridge from the ``slavemode.agent-update`` executor to core's auto-updater.

The agent package must not import core, so core registers a handler here at
startup and the executor calls through it. The handler takes ``check_only``
and returns a JSON-able status dict, raising on failure.
"""
from __future__ import annotations

from typing import Any, Callable

SelfUpdateHandler = Callable[[bool], dict[str, Any]]

_handler: SelfUpdateHandler | None = None


def set_handler(handler: SelfUpdateHandler | None) -> None:
    global _handler
    _handler = handler


def available() -> bool:
    """True if this process can self-update (a handler is registered)."""
    return _handler is not None


def request_update(*, check_only: bool) -> dict[str, Any]:
    if _handler is None:
        raise RuntimeError("Self-update is not available in this process")
    return _handler(check_only)
