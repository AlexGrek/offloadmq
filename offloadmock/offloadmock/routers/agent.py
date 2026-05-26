"""Agent API: `/agent/*` (public) and `/private/agent/*` (JWT-protected).

Mirrors `src/api/agent/mod.rs` + `service.rs`. Per the brief there is no task
subsystem, so polling returns ``null`` and take/resolve/progress on a
non-existent task return 404 — exactly the empty-state behaviour of the server.
"""

from __future__ import annotations

import hashlib
import uuid

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import Response

from .. import deps
from ..config import settings
from ..errors import AppError
from ..schemas import (
    AgentLogSubmission,
    AgentLoginRequest,
    AgentLoginResponse,
    AgentRegistrationRequest,
    AgentRegistrationResponse,
    AgentUpdateRequest,
    BucketStatResponse,
    CommunicationMethod,
    FileStatEntry,
    TaskId,
    TaskResultReport,
    TaskResultStatus,
    TaskUpdate,
)
from ..state import Agent, FileMeta
from ..utils import now_utc

public_router = APIRouter()
private_router = APIRouter(dependencies=[Depends(deps.current_agent)])


def _validate_display_name(name) -> None:
    if name is not None and len(name) > 50:
        raise AppError.bad_request("display_name must be 50 characters or fewer")


# ── public: register / auth ────────────────────────────────────────────────


@public_router.post("/agent/register")
async def register_agent(req: AgentRegistrationRequest) -> dict:
    if req.api_key not in settings.agent_api_keys:
        raise AppError.authorization("Incorrect API key")
    _validate_display_name(req.display_name)
    agent = deps.store.create_agent(req)
    return AgentRegistrationResponse(
        agent_id=agent.uid, key=agent.personal_login_token, message="Registered"
    ).model_dump(by_alias=True)


@public_router.post("/agent/auth")
async def auth_agent(req: AgentLoginRequest) -> dict:
    agent = deps.store.get_agent(req.agent_id)
    if agent is None or agent.personal_login_token != req.key:
        raise AppError.authorization("Incorrect credentials")
    deps.store.touch_agent(agent, CommunicationMethod.HTTP)
    token, expires_in = deps.auth.create_token(req.agent_id)
    return AgentLoginResponse(token=token, expires_in=expires_in).model_dump(by_alias=True)


# ── private: lifecycle ──────────────────────────────────────────────────────


@private_router.get("/ping")
async def agent_ping(agent: Agent = Depends(deps.current_agent)) -> dict:
    deps.store.touch_agent(agent, CommunicationMethod.HTTP)
    return {"status": "ok"}


@private_router.post("/info/update")
async def update_agent_info(
    req: AgentUpdateRequest, agent: Agent = Depends(deps.current_agent)
) -> dict:
    _validate_display_name(req.display_name)
    agent.capabilities = req.capabilities
    agent.capacity = req.capacity
    agent.system_info = req.system_info
    agent.tier = req.tier
    agent.app_version = req.app_version
    agent.display_name = req.display_name
    uid = agent.uid
    key = agent.personal_login_token
    deps.store.touch_agent(agent, CommunicationMethod.HTTP)
    return AgentRegistrationResponse(agent_id=uid, key=key, message="Updated").model_dump(
        by_alias=True
    )


# ── private: agent logs ────────────────────────────────────────────────────


@private_router.post("/logs")
async def submit_agent_log(
    req: AgentLogSubmission, agent: Agent = Depends(deps.current_agent)
) -> dict:
    severity = (req.severity or "").upper()
    if severity not in ("CRITICAL", "ERROR", "INFO"):
        raise AppError.bad_request(f"invalid severity: {req.severity}")
    deps.store.touch_agent(agent, CommunicationMethod.HTTP)
    record_id = uuid.uuid4().hex
    return {
        "recordId": record_id,
        "agentId": req.agent_id or agent.uid,
        "agentName": req.agent_name or agent.display_name or agent.uid[:8],
        "machineFingerprint": req.machine_fingerprint
        or (agent.system_info.machine_id if agent.system_info else None),
        "severity": severity,
        "text": req.text,
        "timestamp": now_utc().isoformat(),
    }


# ── private: task polling ────────────────────────────────────────────────────
#
# The queue is empty until the ``/testing/*`` surface injects tasks. With no
# injected tasks the behaviour matches the original empty-state contract:
# poll → null, take/resolve/progress on a nonexistent task → 404.


@private_router.get("/task/poll_urgent")
async def poll_urgent(agent: Agent = Depends(deps.current_agent)):
    deps.store.touch_agent(agent, CommunicationMethod.HTTP)
    task = deps.store.poll_for(agent, urgent=True)
    return task.to_unassigned_wire() if task is not None else None


@private_router.get("/task/poll")
async def poll_non_urgent(agent: Agent = Depends(deps.current_agent)):
    deps.store.touch_agent(agent, CommunicationMethod.HTTP)
    # Mirror real server: poll_non_urgent checks urgent first, then regular.
    task = deps.store.poll_for(agent, urgent=True) or deps.store.poll_for(
        agent, urgent=False
    )
    return task.to_unassigned_wire() if task is not None else None


@private_router.post("/take/{cap}/{id}")
async def take_task(cap: str, id: str, agent: Agent = Depends(deps.current_agent)):
    task_id = TaskId(cap=cap, id=id)
    deps.store.touch_agent(agent, CommunicationMethod.HTTP)
    task = deps.store.take_task(task_id, agent)
    if task is None:
        raise AppError.not_found(str(task_id))
    return task.to_assigned_wire()


def _result_to_success(status: TaskResultStatus) -> bool:
    """``success`` variant → True; ``failure`` / ``notExecuted`` → False."""
    return "success" in status.root


@private_router.post("/task/resolve/{cap}/{id}")
async def resolve_task(
    cap: str, id: str, report: TaskResultReport, agent: Agent = Depends(deps.current_agent)
):
    task_id = TaskId(cap=cap, id=id)
    if report.id != task_id:
        raise AppError.bad_request(id)
    deps.store.touch_agent(agent, CommunicationMethod.HTTP)
    success = _result_to_success(report.status)
    task = deps.store.resolve_task(task_id, success, report.output)
    if task is None:
        raise AppError.not_found(str(task_id))
    return {"message": "task report confirmed"}


@private_router.post("/task/progress/{cap}/{id}")
async def progress_update(
    cap: str, id: str, update: TaskUpdate, agent: Agent = Depends(deps.current_agent)
):
    task_id = TaskId(cap=cap, id=id)
    if update.id != task_id:
        raise AppError.bad_request(id)
    deps.store.touch_agent(agent, CommunicationMethod.HTTP)
    task = deps.store.progress_task(task_id, update.stage, update.log_update, update.status)
    if task is None:
        raise AppError.not_found(str(task_id))
    return {"message": "task update confirmed"}


# ── private: bucket access ──────────────────────────────────────────────────


@private_router.get("/bucket/{bucket_uid}/stat")
async def bucket_stat(bucket_uid: str) -> dict:
    bucket = deps.store.get_bucket(bucket_uid)
    if bucket is None:
        raise AppError.not_found(f"Bucket {bucket_uid} not found")
    files = [
        FileStatEntry(
            file_uid=f.uid, original_name=f.original_name, size=f.size, sha256=f.sha256
        )
        for f in bucket.files
    ]
    return BucketStatResponse(
        bucket_uid=bucket.uid, file_count=len(files), files=files
    ).model_dump(by_alias=True)


@private_router.get("/bucket/{bucket_uid}/file/{file_uid}")
async def download_bucket_file(bucket_uid: str, file_uid: str) -> Response:
    bucket = deps.store.get_bucket(bucket_uid)
    if bucket is None:
        raise AppError.not_found(f"Bucket {bucket_uid} not found")
    meta = next((f for f in bucket.files if f.uid == file_uid), None)
    if meta is None:
        raise AppError.not_found(f"File {file_uid} not found in bucket {bucket_uid}")
    data = deps.store.get_file(bucket_uid, file_uid)
    base_name = meta.original_name.rsplit("/", 1)[-1].replace('"', '\\"')
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"content-disposition": f'attachment; filename="{base_name}"'},
    )


@private_router.post("/bucket/{bucket_uid}/upload")
async def upload_to_bucket(bucket_uid: str, file: UploadFile = File(...)) -> Response:  # noqa: B008
    return await _store_upload(bucket_uid, file)


async def _store_upload(bucket_uid: str, file: UploadFile) -> Response:
    bucket = deps.store.get_bucket(bucket_uid)
    if bucket is None:
        raise AppError.not_found(f"Bucket {bucket_uid} not found")
    remaining = settings.storage.bucket_size_bytes - bucket.used_bytes
    data = await file.read()
    size = len(data)
    if size > remaining:
        raise AppError.bad_request(
            f"File too large: {size} bytes, only {remaining} bytes remaining in bucket"
        )
    original_name = file.filename or "output"
    file_uid = str(uuid.uuid4())
    sha256 = hashlib.sha256(data).hexdigest()
    deps.store.put_file(bucket_uid, file_uid, data)
    bucket.files.append(
        FileMeta(
            uid=file_uid,
            original_name=original_name,
            size=size,
            sha256=sha256,
            uploaded_at=now_utc(),
        )
    )
    bucket.used_bytes += size
    deps.store.save_bucket(bucket)
    from ..responses import OffloadJSONResponse

    return OffloadJSONResponse(
        status_code=201,
        content={
            "file_uid": file_uid,
            "original_name": original_name,
            "size": size,
            "sha256": sha256,
        },
    )
