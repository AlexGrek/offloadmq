from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class TaskStatus(StrEnum):
    PENDING = "pending"
    ASSIGNED = "assigned"
    COMPLETED = "completed"
    FAILED = "failed"


class Task(BaseModel):
    id: str
    capability: str
    payload: dict[str, Any] = Field(default_factory=dict)
    priority: int = 0


class TaskResult(BaseModel):
    task_id: str
    status: TaskStatus
    output: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class AgentRegistration(BaseModel):
    agent_id: str
    key: str


class AgentAuth(BaseModel):
    token: str
    expires_in: int


class ProgressUpdate(BaseModel):
    task_id: str
    capability: str
    stage: str
    log: str
