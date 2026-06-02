"""Client API: `/api/*` (mirror `src/api/client/mod.rs` + `service.rs`).

Auth via :func:`deps.client_auth`. No task subsystem, so:
* ``submit`` (non-urgent) returns the queued response shape with a fresh id.
* ``submit_blocking`` / urgent ``submit`` replicate the precondition check
  (503 when no online agent provides the capability). When an agent *is*
  available the mock cannot execute work, so it returns a terminal
  ``CompletedPartial`` envelope noting that — see README.
* ``poll`` / ``cancel`` of a non-existent task return 404.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import deps
from ..deps import ClientAuth
from ..errors import AppError
from ..schemas import ApiKeyRequest, TaskId, TaskSubmissionRequest
from ..utils import base_capability, time_sortable_uid

router = APIRouter(dependencies=[Depends(deps.client_auth)])


@router.get("/ping")
async def ping() -> dict:
    # Mirrors health_check, but sits behind client-key auth in main.rs.
    from ..utils import iso_z, now_utc

    return {
        "status": "healthy",
        "agents": deps.store.agent_count(),
        "timestamp": iso_z(now_utc()),
    }


def _validate_file_buckets(req: TaskSubmissionRequest, skip_owner: bool) -> None:
    for bucket_uid in req.file_bucket:
        bucket = deps.store.get_bucket(bucket_uid)
        if bucket is None:
            raise AppError.not_found(f"Bucket {bucket_uid} not found")
        if not skip_owner and bucket.api_key != req.api_key:
            raise AppError.authorization(
                f"Bucket {bucket_uid} is not owned by the provided API key"
            )
        if bucket.rm_after_task and bucket.tasks:
            raise AppError.conflict(
                f"Bucket {bucket_uid} has rm_after_task set and has already been "
                f"used by task {bucket.tasks[0]}"
            )
    if req.output_bucket is not None:
        bucket = deps.store.get_bucket(req.output_bucket)
        if bucket is None:
            raise AppError.not_found(f"Output bucket {req.output_bucket} not found")
        if not skip_owner and bucket.api_key != req.api_key:
            raise AppError.authorization(
                f"Output bucket {req.output_bucket} is not owned by the provided API key"
            )


def _record_task_in_buckets(task_id: str, file_bucket: list[str]) -> None:
    for bucket_uid in file_bucket:
        bucket = deps.store.get_bucket(bucket_uid)
        if bucket is not None:
            bucket.tasks.append(task_id)
            deps.store.save_bucket(bucket)


def _urgent_outcome(req: TaskSubmissionRequest, task_id: TaskId) -> dict:
    # Mirrors scheduler::submit_urgent_task precondition.
    if not deps.store.has_online_agent_for(req.capability):
        raise AppError.scheduling_impossible(
            f"no online runners for capability {req.capability}"
        )
    # OffloadMock does not execute tasks (CompletedPartial shape).
    return {
        "id": task_id.model_dump(by_alias=True),
        "status": "failed",
        "message": "OffloadMock does not execute tasks",
    }


@router.post("/task/submit")
async def submit_task(req: TaskSubmissionRequest, auth: ClientAuth = Depends(deps.client_auth)):
    if not auth.mgmt_override:
        deps.store.verify_key(req.api_key, req.capability)
    task_id = TaskId(cap=req.capability, id=time_sortable_uid())
    _validate_file_buckets(req, auth.mgmt_override)
    _record_task_in_buckets(str(task_id), req.file_bucket)
    if req.urgent:
        return _urgent_outcome(req, task_id)
    return {
        "id": task_id.model_dump(by_alias=True),
        "capability": req.capability,
        "status": "queued",
        "message": "Added to tasks queue",
    }


@router.post("/task/submit_blocking")
async def submit_task_blocking(
    req: TaskSubmissionRequest, auth: ClientAuth = Depends(deps.client_auth)
):
    if not auth.mgmt_override:
        deps.store.verify_key(req.api_key, req.capability)
    if not req.urgent:
        raise AppError.bad_request("Only urgent tasks can be submitted to this endpoint")
    task_id = TaskId(cap=req.capability, id=time_sortable_uid())
    _validate_file_buckets(req, auth.mgmt_override)
    _record_task_in_buckets(str(task_id), req.file_bucket)
    return _urgent_outcome(req, task_id)


@router.post("/task/poll/{cap}/{id}")
async def poll_task_status(
    cap: str, id: str, req: ApiKeyRequest, auth: ClientAuth = Depends(deps.client_auth)
):
    task_id = TaskId(cap=cap, id=id)
    raise AppError.not_found(str(task_id))


@router.post("/task/cancel/{cap}/{id}")
async def cancel_task(
    cap: str, id: str, req: ApiKeyRequest, auth: ClientAuth = Depends(deps.client_auth)
):
    task_id = TaskId(cap=cap, id=id)
    raise AppError.not_found(str(task_id))


def _capabilities(auth: ClientAuth, api_key: str, strip_extended: bool) -> list[str]:
    caps = deps.store.online_capabilities(strip_extended)
    if not auth.mgmt_override:
        key = deps.store.find_active_key(api_key)
        if key is None:
            raise AppError.authorization("API key not found")
        caps = {
            c
            for c in caps
            if deps.store.has_capability(key.capabilities, base_capability(c))
        }
    return list(caps)


@router.post("/capabilities/online")
async def capabilities_online(req: ApiKeyRequest, auth: ClientAuth = Depends(deps.client_auth)):
    return _capabilities(auth, req.api_key, strip_extended=True)


@router.post("/capabilities/list/online_ext")
async def capabilities_online_ext(
    req: ApiKeyRequest, auth: ClientAuth = Depends(deps.client_auth)
):
    return _capabilities(auth, req.api_key, strip_extended=False)
