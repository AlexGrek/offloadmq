"""In-memory application state, mirroring the relevant pieces of
`src/db/*` and `src/state.rs`.

Per the task brief there is **no task subsystem** — tasks are assumed empty.
What is modelled with real behaviour: agents, client API keys, and storage
buckets, since the API layer for those returns data derived from this state.
"""

from __future__ import annotations

import threading
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_serializer

from .config import AppConfig
from .schemas import (
    CamelModel,
    CommunicationMethod,
    SnakeModel,
    SystemInfo,
    TaskId,
    TaskStatus,
    TaskSubmissionRequest,
)
from .utils import base_capability, get_last_six_chars, iso_z, now_utc, time_sortable_uid

ONLINE_TIMEOUT_SECS = 120


# ---------------------------------------------------------------------------
# Models held in state (their JSON shape is part of the public API)
# ---------------------------------------------------------------------------


class Agent(CamelModel):
    """Mirror of `models::Agent` (serde camelCase)."""

    uid: str
    uid_short: str
    personal_login_token: str
    registered_at: datetime
    last_contact: Optional[datetime] = None
    last_comm_method: CommunicationMethod = CommunicationMethod.HTTP
    capabilities: List[str]
    tier: int
    capacity: int
    system_info: SystemInfo
    app_version: Optional[str] = None
    display_name: Optional[str] = None

    @field_serializer("registered_at")
    def _ser_registered_at(self, v: datetime) -> str:
        return iso_z(v)

    @field_serializer("last_contact")
    def _ser_last_contact(self, v: Optional[datetime]) -> Optional[str]:
        return iso_z(v) if v is not None else None

    def last_activity_at(self) -> datetime:
        return self.last_contact or self.registered_at

    def is_online(self) -> bool:
        return now_utc() - self.last_activity_at() <= timedelta(seconds=ONLINE_TIMEOUT_SECS)


class ClientApiKey(CamelModel):
    """Mirror of `models::ClientApiKey` (serde camelCase)."""

    key: str
    capabilities: List[str]
    is_predefined: bool = False
    created: datetime
    is_revoked: bool = False

    @field_serializer("created")
    def _ser_created(self, v: datetime) -> str:
        return iso_z(v)


class FileMeta(SnakeModel):
    uid: str
    original_name: str
    size: int
    sha256: str
    uploaded_at: datetime


class BucketMeta(SnakeModel):
    uid: str
    api_key: str
    created_at: datetime
    files: List[FileMeta] = Field(default_factory=list)
    used_bytes: int = 0
    tasks: List[str] = Field(default_factory=list)
    rm_after_task: bool = False


class MockTask(BaseModel):
    """A task injected via the ``/testing/*`` surface.

    Holds the union of the wire types ``UnassignedTask`` and ``AssignedTask``
    so the same record can serve both poll and take. ``data`` is a full
    :class:`TaskSubmissionRequest` so its wire shape (``payload``,
    ``capability``, ``file_bucket``, …) matches the real server byte-for-byte
    when serialized with ``by_alias=True``.
    """

    id: TaskId
    data: TaskSubmissionRequest
    created_at: datetime
    urgent: bool = False
    status: TaskStatus = TaskStatus.QUEUED
    agent_id: Optional[str] = None
    assigned_at: Optional[datetime] = None
    result: Optional[Any] = None
    log: Optional[str] = None
    stage: Optional[str] = None
    target_agent_id: Optional[str] = None
    source: str = "testing"
    history: List[Dict[str, Any]] = Field(default_factory=list)

    def key(self) -> str:
        return f"{self.id.cap}[{self.id.id}]"

    def is_assignable(self) -> bool:
        return self.agent_id is None and not self.status.is_terminal()

    def to_unassigned_wire(self) -> Dict[str, Any]:
        return {
            "id": self.id.model_dump(by_alias=True),
            "data": self.data.model_dump(by_alias=True),
            "createdAt": iso_z(self.created_at),
        }

    def to_assigned_wire(self) -> Dict[str, Any]:
        return {
            "id": self.id.model_dump(by_alias=True),
            "data": self.data.model_dump(by_alias=True),
            "agentId": self.agent_id or "",
            "status": self.status.value,
            "history": self.history,
            "createdAt": iso_z(self.created_at),
            "assignedAt": iso_z(self.assigned_at) if self.assigned_at else None,
            "result": self.result,
            "log": self.log,
            "stage": self.stage,
            "typicalRuntimeSeconds": None,
            "cancelRequestedAt": None,
            "finishedAt": None,
            "lastUpdateAt": iso_z(self.assigned_at) if self.assigned_at else None,
        }

    def to_inspect_wire(self) -> Dict[str, Any]:
        """Compact shape returned by the testing inspection endpoints."""
        return {
            "id": self.id.model_dump(by_alias=True),
            "capability": self.id.cap,
            "urgent": self.urgent,
            "status": self.status.value,
            "agentId": self.agent_id,
            "targetAgentId": self.target_agent_id,
            "source": self.source,
            "createdAt": iso_z(self.created_at),
            "assignedAt": iso_z(self.assigned_at) if self.assigned_at else None,
            "stage": self.stage,
            "log": self.log,
            "result": self.result,
            "payload": self.data.payload,
            "history": self.history,
        }


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------


class AppStore:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self._lock = threading.RLock()
        self.agents: Dict[str, Agent] = {}
        self.client_keys: Dict[str, ClientApiKey] = {}
        # File payloads live alongside metadata, keyed by (bucket_uid, file_uid).
        self.buckets: Dict[str, BucketMeta] = {}
        self.file_data: Dict[tuple[str, str], bytes] = {}
        # Tasks injected via /testing/*. Insertion order is preserved so polls
        # return the oldest matching unassigned task first.
        self.tasks: Dict[str, MockTask] = {}
        self._init_client_keys()

    def _init_client_keys(self) -> None:
        # Mirrors ApiKeysStorage::initialize_from_list — predefined wildcard keys.
        for key in self.config.client_api_keys:
            self.client_keys[key] = ClientApiKey(
                key=key,
                capabilities=["*"],
                is_predefined=True,
                created=now_utc(),
                is_revoked=False,
            )

    # ── agents ─────────────────────────────────────────────────────────────
    def agent_count(self) -> int:
        return len(self.agents)

    def list_agents(self) -> List[Agent]:
        return list(self.agents.values())

    def list_online_agents(self) -> List[Agent]:
        return [a for a in self.agents.values() if a.is_online()]

    def get_agent(self, uid: str) -> Optional[Agent]:
        return self.agents.get(uid)

    def create_agent(self, req) -> Agent:  # req: AgentRegistrationRequest
        uid = time_sortable_uid()
        now = now_utc()
        agent = Agent(
            uid=uid,
            uid_short=get_last_six_chars(uid),
            personal_login_token=str(uuid.uuid4()),
            registered_at=now,
            last_contact=now,
            last_comm_method=CommunicationMethod.HTTP,
            capabilities=req.capabilities,
            tier=req.tier,
            capacity=req.capacity,
            system_info=req.system_info,
            app_version=req.app_version,
            display_name=req.display_name,
        )
        with self._lock:
            self.agents[uid] = agent
        return agent

    def save_agent(self, agent: Agent) -> None:
        with self._lock:
            self.agents[agent.uid] = agent

    def touch_agent(self, agent: Agent, comm: CommunicationMethod) -> Agent:
        agent.last_contact = now_utc()
        agent.last_comm_method = comm
        self.save_agent(agent)
        return agent

    def delete_agent(self, uid: str) -> bool:
        with self._lock:
            return self.agents.pop(uid, None) is not None

    def clear_agents(self) -> None:
        with self._lock:
            self.agents.clear()

    def online_capabilities(self, strip_extended: bool) -> set[str]:
        from .utils import base_capability

        caps: set[str] = set()
        for agent in self.list_online_agents():
            for cap in agent.capabilities:
                caps.add(base_capability(cap) if strip_extended else cap)
        return caps

    def has_online_agent_for(self, capability: str) -> bool:
        from .utils import base_capability

        base = base_capability(capability)
        for agent in self.list_online_agents():
            if any(base_capability(c) == base for c in agent.capabilities):
                return True
        return False

    # ── client keys ──────────────────────────────────────────────────────
    def find_active_key(self, key: str) -> Optional[ClientApiKey]:
        return self.client_keys.get(key)

    def is_key_real_not_revoked(self, key: str) -> bool:
        k = self.client_keys.get(key)
        return bool(k and not k.is_revoked)

    def verify_key(self, key: str, cap: str) -> None:
        from .errors import AppError

        k = self.client_keys.get(key)
        if k and not k.is_revoked and self.has_capability(k.capabilities, cap):
            return
        raise AppError.authorization("API key invalid")

    def list_keys(self) -> List[ClientApiKey]:
        return list(self.client_keys.values())

    def upsert_key(self, key: ClientApiKey) -> None:
        with self._lock:
            self.client_keys[key.key] = key

    def revoke_key(self, key_id: str) -> Optional[ClientApiKey]:
        with self._lock:
            k = self.client_keys.get(key_id)
            if k is None:
                return None
            k.is_revoked = True
            # update_key archives revoked keys (removes from active store).
            self.client_keys.pop(key_id, None)
            return k

    @staticmethod
    def has_capability(key_capabilities: List[str], required_cap: str) -> bool:
        for cap in key_capabilities:
            if cap == "*":
                return True
            if cap.endswith("*"):
                if required_cap.startswith(cap[:-1]):
                    return True
            elif cap == required_cap:
                return True
        return False

    # ── buckets ──────────────────────────────────────────────────────────
    def get_bucket(self, uid: str) -> Optional[BucketMeta]:
        return self.buckets.get(uid)

    def list_buckets_for_key(self, api_key: str) -> List[BucketMeta]:
        return [b for b in self.buckets.values() if b.api_key == api_key]

    def list_all_buckets(self) -> List[BucketMeta]:
        return list(self.buckets.values())

    def count_buckets_for_key(self, api_key: str) -> int:
        return sum(1 for b in self.buckets.values() if b.api_key == api_key)

    def create_bucket(self, api_key: str, rm_after_task: bool) -> BucketMeta:
        bucket = BucketMeta(
            uid=str(uuid.uuid4()),
            api_key=api_key,
            created_at=now_utc(),
            files=[],
            used_bytes=0,
            tasks=[],
            rm_after_task=rm_after_task,
        )
        with self._lock:
            self.buckets[bucket.uid] = bucket
        return bucket

    def save_bucket(self, bucket: BucketMeta) -> None:
        with self._lock:
            self.buckets[bucket.uid] = bucket

    def delete_bucket(self, uid: str) -> None:
        with self._lock:
            self.buckets.pop(uid, None)
            for key in [k for k in self.file_data if k[0] == uid]:
                self.file_data.pop(key, None)

    def expired_buckets(self, ttl_minutes: int) -> List[BucketMeta]:
        cutoff = now_utc() - timedelta(minutes=ttl_minutes)
        return [b for b in self.buckets.values() if b.created_at < cutoff]

    def put_file(self, bucket_uid: str, file_uid: str, data: bytes) -> None:
        with self._lock:
            self.file_data[(bucket_uid, file_uid)] = data

    def get_file(self, bucket_uid: str, file_uid: str) -> bytes:
        return self.file_data.get((bucket_uid, file_uid), b"")

    def delete_file(self, bucket_uid: str, file_uid: str) -> None:
        with self._lock:
            self.file_data.pop((bucket_uid, file_uid), None)

    # ── tasks (testing surface) ──────────────────────────────────────────
    def add_task(self, task: MockTask) -> MockTask:
        with self._lock:
            self.tasks[task.key()] = task
        return task

    def get_task(self, task_id: TaskId) -> Optional[MockTask]:
        return self.tasks.get(f"{task_id.cap}[{task_id.id}]")

    def list_tasks(self) -> List[MockTask]:
        return list(self.tasks.values())

    def reset_tasks(self) -> int:
        with self._lock:
            n = len(self.tasks)
            self.tasks.clear()
            return n

    def poll_for(self, agent: Agent, urgent: bool) -> Optional[MockTask]:
        """First unassigned task whose base capability matches the agent."""
        agent_bases = {base_capability(c) for c in agent.capabilities}
        with self._lock:
            for task in self.tasks.values():
                if not task.is_assignable():
                    continue
                if task.urgent != urgent:
                    continue
                if (
                    task.target_agent_id is not None
                    and task.target_agent_id != agent.uid
                ):
                    continue
                if base_capability(task.id.cap) in agent_bases:
                    return task
        return None

    def take_task(self, task_id: TaskId, agent: Agent) -> Optional[MockTask]:
        with self._lock:
            task = self.tasks.get(f"{task_id.cap}[{task_id.id}]")
            if task is None or not task.is_assignable():
                return None
            if (
                task.target_agent_id is not None
                and task.target_agent_id != agent.uid
            ):
                return None
            task.agent_id = agent.uid
            task.status = TaskStatus.ASSIGNED
            task.assigned_at = now_utc()
            task.history.append(
                {
                    "event": "assigned",
                    "agentId": agent.uid,
                    "at": iso_z(task.assigned_at),
                }
            )
            return task

    def progress_task(
        self,
        task_id: TaskId,
        stage: Optional[str],
        log_update: Optional[str],
        status: Optional[TaskStatus],
    ) -> Optional[MockTask]:
        with self._lock:
            task = self.tasks.get(f"{task_id.cap}[{task_id.id}]")
            if task is None or task.agent_id is None:
                return None
            if stage is not None:
                task.stage = stage
            if log_update is not None:
                task.log = (task.log or "") + log_update
            if status is not None:
                task.status = status
            task.history.append(
                {
                    "event": "progress",
                    "stage": stage,
                    "status": status.value if status else None,
                    "at": iso_z(now_utc()),
                }
            )
            return task

    def resolve_task(
        self, task_id: TaskId, success: bool, output: Any
    ) -> Optional[MockTask]:
        with self._lock:
            task = self.tasks.get(f"{task_id.cap}[{task_id.id}]")
            if task is None or task.agent_id is None:
                return None
            if task.status == TaskStatus.CANCEL_REQUESTED:
                task.status = TaskStatus.CANCELED
            else:
                task.status = TaskStatus.COMPLETED if success else TaskStatus.FAILED
            task.result = output
            task.history.append(
                {
                    "event": "resolved",
                    "success": success,
                    "status": task.status.value,
                    "at": iso_z(now_utc()),
                }
            )
            return task

    def request_cancel(self, task_id: TaskId) -> Optional[MockTask]:
        with self._lock:
            task = self.tasks.get(f"{task_id.cap}[{task_id.id}]")
            if task is None or task.status.is_terminal():
                return None
            task.status = TaskStatus.CANCEL_REQUESTED
            task.history.append(
                {"event": "cancelRequested", "at": iso_z(now_utc())}
            )
            return task

    def has_pending_or_assigned_for(self, capability: str) -> bool:
        base = base_capability(capability)
        with self._lock:
            for task in self.tasks.values():
                if (
                    base_capability(task.id.cap) == base
                    and not task.status.is_terminal()
                ):
                    return True
        return False
