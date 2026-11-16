from __future__ import annotations

import time
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class TaskStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class LogLevel(StrEnum):
    INFO = "info"
    PROGRESS = "progress"
    WARN = "warn"
    ERROR = "error"


class Task(BaseModel):
    id: str
    capability: str
    payload: dict[str, Any] = Field(default_factory=dict)
    priority: int = 0
    # Full server-pushed task frame (id + data + createdAt) for legacy executors.
    server_task: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def from_wire(cls, raw: dict[str, Any]) -> Task:
        """Parse a task frame pushed over the agent WebSocket (no HTTP polling)."""
        tid = raw.get("id") or {}
        data = raw.get("data") or {}
        cap = str(tid.get("cap", data.get("capability", "")))
        task_id = str(tid.get("id", ""))
        return cls(
            id=task_id,
            capability=cap,
            payload=dict(data.get("payload") or {}),
            server_task=raw,
        )


def describe_exception(exc: BaseException) -> str:
    """A failure reason that is never empty.

    ``str(exc)`` is ``""`` for timeouts and many bare raises, which used to
    reach clients as a contentless "failed". Keep the exception type so the
    reason stays diagnosable; ``RuntimeError`` messages are already ours and
    read better without it.
    """
    name = type(exc).__name__
    message = str(exc).strip()
    if isinstance(exc, TimeoutError) and not message:
        return f"{name}: timed out"
    if not message:
        return f"{name} (no message)"
    if type(exc) is RuntimeError:
        return message
    return f"{name}: {message}"


class TaskResult(BaseModel):
    task_id: str
    status: TaskStatus
    output: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class LogEntry(BaseModel):
    """A single structured log line attached to a task."""

    ts: float = Field(default_factory=time.time)
    level: LogLevel = LogLevel.INFO
    stage: str = ""
    message: str = ""
    data: dict[str, Any] = Field(default_factory=dict)


class AgentRegistration(BaseModel):
    agent_id: str
    key: str


class AgentAuth(BaseModel):
    token: str
    expires_in: int
