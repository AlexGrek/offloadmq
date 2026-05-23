"""Executor protocol and registry.

An executor is an async callable that takes a Task and an ExecContext and
returns a TaskResult. Executors are registered by capability prefix.
"""
from __future__ import annotations

from typing import Callable, Protocol

from offloadmq_agent.context import ExecContext
from offloadmq_agent.models import Task, TaskResult


class Executor(Protocol):
    async def __call__(self, task: Task, ctx: ExecContext) -> TaskResult: ...


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


def registered_prefixes() -> list[str]:
    return sorted(_registry.keys())
