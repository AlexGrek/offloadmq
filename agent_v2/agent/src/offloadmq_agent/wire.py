"""Wire-format models for OffloadMQ agent task reporting."""
from __future__ import annotations

from datetime import timedelta
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel, ConfigDict, Field


class TaskId(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    cap: str

    def quoted(self) -> TaskId:
        return TaskId(id=quote(self.id, safe=""), cap=quote(self.cap, safe=""))

    def to_wire(self) -> dict[str, str]:
        return {"id": self.id, "cap": self.cap}


class TaskResultStatus(BaseModel):
    status: str
    data: Any

    def to_wire(self) -> dict[str, Any]:
        if self.status == "success":
            if isinstance(self.data, timedelta):
                return {"success": self.data.total_seconds()}
            raise ValueError("success status expects timedelta data")
        if self.status == "failure":
            if (
                isinstance(self.data, (list, tuple))
                and len(self.data) == 2
                and isinstance(self.data[1], timedelta)
            ):
                return {"failure": [self.data[0], self.data[1].total_seconds()]}
            raise ValueError("failure status expects (message, timedelta)")
        return {"notExecuted": self.data}


class TaskResultReport(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    task_id: TaskId = Field(alias="id")
    status: TaskResultStatus
    output: dict[str, Any] | None = None
    capability: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.task_id.to_wire(),
            "status": self.status.to_wire(),
            "output": self.output,
            "capability": self.capability,
        }


def progress_wire_status(stage: str | None, has_log: bool) -> str | None:
    """JSON TaskStatus strings for the progress API (serde camelCase on the server).

    Any progress report from an executing agent implies the task is running;
    without this the server keeps the task in `assigned` and status-driven
    consumers (e.g. OAI's execution-anchored progress bar) never see it start.
    """
    if stage == "cancelled":
        return None
    if stage == "starting":
        return "starting"
    if has_log or stage is not None:
        return "running"
    return None


class TaskProgressReport(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    task_id: TaskId = Field(alias="id")
    stage: str | None = None
    log_update: str | None = None
    status: str | None = None

    def to_wire(self) -> dict[str, Any]:
        wire: dict[str, Any] = {"id": self.task_id.to_wire()}
        if self.stage is not None:
            wire["stage"] = self.stage
        if self.log_update is not None:
            wire["logUpdate"] = self.log_update
        if self.status is not None:
            wire["status"] = self.status
        return wire
