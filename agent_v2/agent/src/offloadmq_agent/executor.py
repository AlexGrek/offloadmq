"""Executor protocol and registry."""
from __future__ import annotations

from typing import Any, Callable, Coroutine, Protocol

from offloadmq_agent.models import Task, TaskResult


class Executor(Protocol):
    async def __call__(
        self,
        task: Task,
        report_progress: Callable[[str, str], Coroutine[Any, Any, None]],
    ) -> TaskResult: ...


# Maps capability prefix → executor callable.
_registry: dict[str, Executor] = {}


def register(prefix: str) -> Callable[[Executor], Executor]:
    def decorator(fn: Executor) -> Executor:
        _registry[prefix] = fn
        return fn
    return decorator


def find(capability: str) -> Executor | None:
    """Return the executor whose registered prefix matches the capability."""
    for prefix, executor in _registry.items():
        if capability == prefix or capability.startswith(prefix + "."):
            return executor
    return None
