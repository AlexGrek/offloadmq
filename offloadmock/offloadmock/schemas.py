"""Pydantic models mirroring `src/schema.rs` and `src/models.rs` exactly.

Field names, casing (serde `rename_all = "camelCase"` and explicit renames),
optionality, defaults and skip-when-none behaviour all match the Rust structs.

Notes on fidelity:
* camelCase models derive their JSON keys from `to_camel`; explicit per-field
  renames (e.g. `file_bucket`, `output_bucket`) override that, matching serde.
* `SystemInfo` / `GpuInfo` accept either the GB field or a legacy MB field on
  input and round MB -> GB, exactly like the custom `Deserialize` impls.
* Fields without `#[serde(default)]` in Rust are required here too.
* `DateTime<Utc>` is serialized RFC 3339 with a trailing `Z` (chrono style).
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    field_serializer,
    model_validator,
)
from pydantic.alias_generators import to_camel

from .utils import mb_to_gb_rounded

# ---------------------------------------------------------------------------
# Base classes
# ---------------------------------------------------------------------------


class CamelModel(BaseModel):
    """Base for structs with serde `rename_all = "camelCase"`."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)


class SnakeModel(BaseModel):
    """Base for structs with serde default (snake_case) naming."""

    model_config = ConfigDict(populate_by_name=True)


# ---------------------------------------------------------------------------
# Enums & common types
# ---------------------------------------------------------------------------


class TaskStatus(str, Enum):
    PENDING = "pending"
    QUEUED = "queued"
    ASSIGNED = "assigned"
    STARTING = "starting"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCEL_REQUESTED = "cancelRequested"
    CANCELED = "canceled"

    def is_terminal(self) -> bool:
        return self in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELED)


class CommunicationMethod(str, Enum):
    HTTP = "http"
    WEBSOCKET = "ws"


class TaskResultStatus(RootModel[Dict[str, Any]]):
    """Externally-tagged result status (`TaskResultStatus` enum).

    Valid shapes (serde camelCase variant tags):
      ``{"success": <f64>}``
      ``{"failure": [<msg>, <f64>]}``
      ``{"notExecuted": <msg>}``
    """

    @model_validator(mode="after")
    def _validate(self) -> "TaskResultStatus":
        keys = set(self.root.keys())
        allowed = {"success", "failure", "notExecuted"}
        if len(keys) != 1 or not keys <= allowed:
            raise ValueError(
                "TaskResultStatus must have exactly one of: success, failure, notExecuted"
            )
        return self


# ---------------------------------------------------------------------------
# System info
# ---------------------------------------------------------------------------


class GpuInfo(CamelModel):
    vendor: str
    model: str
    vram_gb: int = 0

    @model_validator(mode="before")
    @classmethod
    def _coerce_vram(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        d = dict(data)
        gb = d.get("vramGb", d.get("vram_gb"))
        mb = d.get("vramMb", d.get("vram_mb"))
        if gb is None:
            d["vramGb"] = mb_to_gb_rounded(int(mb)) if mb is not None else 0
        return d


class SystemInfo(CamelModel):
    os: str
    client: str
    runtime: str
    cpu_arch: str
    cpu_model: Optional[str] = None
    total_memory_gb: int = 0
    gpu: Optional[GpuInfo] = None
    machine_id: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _coerce_mem(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        d = dict(data)
        gb = d.get("totalMemoryGb", d.get("total_memory_gb"))
        mb = d.get("totalMemoryMb", d.get("total_memory_mb"))
        if gb is None:
            d["totalMemoryGb"] = mb_to_gb_rounded(int(mb)) if mb is not None else 0
        return d


# ---------------------------------------------------------------------------
# Agent lifecycle API
# ---------------------------------------------------------------------------


class AgentRegistrationRequest(CamelModel):
    capabilities: List[str]
    tier: int
    capacity: int
    system_info: SystemInfo
    api_key: str
    app_version: Optional[str] = None
    display_name: Optional[str] = None


class AgentUpdateRequest(CamelModel):
    capabilities: List[str]
    tier: int
    capacity: int
    system_info: SystemInfo
    app_version: Optional[str] = None
    display_name: Optional[str] = None


class CreateApiKeyRequest(CamelModel):
    key: str
    capabilities: List[str]


class AgentRegistrationResponse(CamelModel):
    agent_id: str
    key: str
    message: str


class AgentLoginRequest(CamelModel):
    agent_id: str
    key: str


class AgentLoginResponse(CamelModel):
    token: str
    expires_in: int


# ---------------------------------------------------------------------------
# File references & task submission
# ---------------------------------------------------------------------------


class FileReference(CamelModel):
    path: str
    bucket: Optional[str] = None
    git_clone: Optional[str] = None
    get: Optional[str] = None
    post: Optional[str] = None
    request: Optional[str] = None
    http_login: Optional[str] = None
    http_password: Optional[str] = None
    http_auth_header: Optional[str] = None
    custom_header: Optional[Dict[str, str]] = None
    s3_file: Optional[str] = None
    custom_auth: Optional[str] = None


class TaskSubmissionRequest(CamelModel):
    capability: str
    urgent: bool = False
    restartable: bool = False
    payload: Any
    fetch_files: List[FileReference] = Field(default_factory=list)
    # serde explicitly renames these two to snake_case, overriding camelCase.
    file_bucket: List[str] = Field(default_factory=list, alias="file_bucket")
    output_bucket: Optional[str] = Field(default=None, alias="output_bucket")
    timeout_secs: Optional[int] = Field(default=None, alias="timeoutSecs")
    max_wait_secs: Optional[int] = Field(default=None, alias="maxWaitSecs")
    runtime_secs: Optional[int] = Field(default=None, alias="runtimeSecs")
    artifacts: List[FileReference] = Field(default_factory=list)
    data_preparation: Dict[str, str] = Field(default_factory=dict)
    api_key: str


class ApiKeyRequest(CamelModel):
    api_key: str


class TaskId(CamelModel):
    cap: str
    id: str

    def __str__(self) -> str:  # mirrors Display: "{cap}[{id}]"
        return f"{self.cap}[{self.id}]"


class TaskSubmissionResponse(CamelModel):
    task: TaskId


class TaskStatusResponse(CamelModel):
    id: TaskId
    status: TaskStatus
    created_at: datetime
    # skip_serializing_if = Option::is_none
    stage: Optional[str] = None
    output: Optional[Any] = None
    # plain Option<String> (no skip): always serialized, may be null.
    log: Optional[str] = None
    typical_runtime_seconds: Optional[Any] = None

    @field_serializer("created_at")
    def _ser_created_at(self, v: datetime) -> str:
        from .utils import iso_z

        return iso_z(v)


class TaskAssignment(CamelModel):
    id: TaskId
    payload: Any


class TaskResultReport(CamelModel):
    id: TaskId
    capability: str
    status: TaskResultStatus
    output: Optional[Any] = None


class TaskUpdate(CamelModel):
    id: TaskId
    stage: Optional[str] = None
    log_update: Optional[str] = None
    status: Optional[TaskStatus] = None


# ---------------------------------------------------------------------------
# Bucket stat (agent-facing; serde default snake_case naming)
# ---------------------------------------------------------------------------


class FileStatEntry(SnakeModel):
    file_uid: str
    original_name: str
    size: int
    sha256: str


class BucketStatResponse(SnakeModel):
    bucket_uid: str
    file_count: int
    files: List[FileStatEntry]


# ---------------------------------------------------------------------------
# Testing API (`/testing/*`) — not part of the real Rust server
# ---------------------------------------------------------------------------


class GenerateTasksRequest(CamelModel):
    """Inject one or more synthetic tasks for ``capability`` into the queue."""

    capability: str
    count: int = 1
    urgent: bool = False
    restartable: bool = False
    randomize: bool = True
    # Optional payload override; if absent, a template payload is generated.
    payload: Optional[Any] = None
    # Optional explicit api_key on the synthetic submission (defaults to the
    # first configured CLIENT_API_KEYS entry).
    api_key: Optional[str] = None
    # Restrict polling to a single agent (useful for slavemode targeting).
    target_agent_id: Optional[str] = None
    # Pass-through submission knobs.
    timeout_secs: Optional[int] = Field(default=None, alias="timeoutSecs")
    max_wait_secs: Optional[int] = Field(default=None, alias="maxWaitSecs")
    runtime_secs: Optional[int] = Field(default=None, alias="runtimeSecs")
    file_bucket: List[str] = Field(default_factory=list, alias="file_bucket")
    output_bucket: Optional[str] = Field(default=None, alias="output_bucket")


class IssueSlavemodeCommandRequest(CamelModel):
    """Inject a ``slavemode.*`` control task.

    ``command`` accepts either the bare suffix (e.g. ``force-rescan``) or the
    fully-qualified ``slavemode.force-rescan``. Defaults to non-urgent (mirrors
    a normal client submit); set ``urgent=true`` for the in-memory urgent queue.
    """

    command: str
    payload: Optional[Any] = None
    target_agent_id: Optional[str] = None
    urgent: bool = False
    api_key: Optional[str] = None
