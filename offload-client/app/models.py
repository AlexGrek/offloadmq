from pydantic import BaseModel, Field
from typing import Optional, Dict, Any, List, Tuple
from datetime import timedelta
from urllib.parse import quote


class TaskResultStatus(BaseModel):
    status: str
    # For success -> timedelta; for failure -> Tuple[str, timedelta]; for notExecuted -> Any
    data: Any

    def to_wire(self) -> Dict[str, Any]:
        """Serialize to the server's expected shape, preserving original logic."""
        if self.status == "success":
            # original: {"success": duration_seconds}
            if isinstance(self.data, timedelta):
                return {"success": self.data.total_seconds()}
            raise ValueError("success status expects timedelta data")
        elif self.status == "failure":
            # original: {"failure": [error_message, duration_seconds]}
            if (
                isinstance(self.data, (list, tuple))
                and len(self.data) == 2
                and isinstance(self.data[1], timedelta)
            ):
                return {"failure": [self.data[0], self.data[1].total_seconds()]}
            raise ValueError("failure status expects (message, timedelta)")
        else:  # notExecuted
            return {"notExecuted": self.data}


class TaskId(BaseModel):
    id: str
    cap: str

    def quoted(self) -> "TaskId":
        # Quote both parts consistently; slashes break the app otherwise
        return TaskId(id=quote(self.id, safe=""), cap=quote(self.cap, safe=""))

    def to_wire(self) -> Dict[str, str]:
        # q = self.quoted()
        return {"id": self.id, "cap": self.cap}


class TaskResultReport(BaseModel):
    task_id: TaskId = Field(..., alias="id")
    status: TaskResultStatus
    output: Optional[dict]
    capability: str

    class Config:
        validate_by_name = True

    def to_wire(self) -> Dict[str, Any]:
        return {
            "id": self.task_id.to_wire(),
            "status": self.status.to_wire(),
            "output": self.output,
            "capability": self.capability,
        }


class TaskProgressReport(BaseModel):
    task_id: TaskId = Field(..., alias="id")
    stage: Optional[str]
    log_update: Optional[str]

    class Config:
        validate_by_name = True

    def to_wire(self) -> Dict[str, Any]:
        return {
            "id": self.task_id.to_wire(),
            "stage": str(self.stage),
            "logUpdate": str(self.log_update),
        }
