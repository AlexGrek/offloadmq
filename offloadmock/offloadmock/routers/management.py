"""Management API: `/management/*` (mirror `src/api/mgmt/*`).

Auth via the management bearer token (:func:`deps.require_mgmt`). Covers
agents, client keys, capabilities, tasks (empty), storage admin, heuristics
(empty) and service logs (empty).
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query

from .. import deps
from ..config import settings
from ..errors import AppError
from ..schemas import CreateApiKeyRequest, TaskId
from ..state import ClientApiKey
from ..utils import iso_z, now_utc

router = APIRouter(dependencies=[Depends(deps.require_mgmt)])


# ── version & capabilities ──────────────────────────────────────────────────


@router.get("/version")
async def version() -> dict:
    return {"version": settings.app_version}


@router.get("/capabilities/list/online")
async def capabilities_online() -> list[str]:
    return list(deps.store.online_capabilities(strip_extended=True))


@router.get("/capabilities/list/online_ext")
async def capabilities_online_ext() -> list[str]:
    return list(deps.store.online_capabilities(strip_extended=False))


# ── tasks ───────────────────────────────────────────────────────────────────
#
# The queue is populated by the ``/testing/*`` surface; if nothing has been
# injected this returns the empty-state envelope, matching the original
# "no task subsystem" contract.


TASK_LIST_DEFAULT_LIMIT = 200
TASK_LIST_MAX_LIMIT = 1000


def _activity_ts(wire: dict) -> str:
    """Latest timestamp on an assigned wire task (ISO-Z strings sort lexically)."""
    return wire.get("finishedAt") or wire.get("lastUpdateAt") or wire.get("createdAt") or ""


@router.get("/tasks/list")
async def list_tasks(
    status: Optional[str] = Query(None),
    limit: Optional[int] = Query(None, ge=0),
    since: Optional[str] = Query(None),
) -> dict:
    """Bounded listing mirroring ``api::mgmt::list_tasks``: ``status`` is
    ``active|terminal|all``, every list is capped at ``limit`` (default 200,
    max 1000), assigned tasks are newest-first, and ``meta`` reports totals."""
    if status not in (None, "all", "active", "terminal"):
        raise AppError.validation(
            f"status must be one of active, terminal, all (got '{status}')"
        )
    status = status or "all"
    since_ts: Optional[str] = None
    if since is not None:
        try:
            parsed = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise AppError.bad_request(f"since must be an RFC 3339 timestamp (got '{since}')")
        since_ts = iso_z(parsed)
    cap = min(TASK_LIST_DEFAULT_LIMIT if limit is None else limit, TASK_LIST_MAX_LIMIT)
    include_queued = status != "terminal"

    urgent_assigned: list[dict] = []
    urgent_unassigned: list[dict] = []
    reg_assigned: list[dict] = []
    reg_unassigned: list[dict] = []
    for task in deps.store.list_tasks():
        if task.agent_id is None and not task.status.is_terminal():
            if include_queued:
                wire = task.to_unassigned_wire()
                (urgent_unassigned if task.urgent else reg_unassigned).append(wire)
            continue
        if status == "active" and task.status.is_terminal():
            continue
        if status == "terminal" and not task.status.is_terminal():
            continue
        wire = task.to_assigned_wire()
        if since_ts and _activity_ts(wire) < since_ts:
            continue
        (urgent_assigned if task.urgent else reg_assigned).append(wire)

    reg_assigned.sort(key=_activity_ts, reverse=True)
    urgent_assigned.sort(key=_activity_ts, reverse=True)
    totals = {
        "urgent_assigned": len(urgent_assigned),
        "urgent_unassigned": len(urgent_unassigned),
        "regular_assigned": len(reg_assigned),
        "regular_unassigned": len(reg_unassigned),
    }
    lists = [urgent_assigned, urgent_unassigned, reg_assigned, reg_unassigned]
    return {
        "urgent": {"assigned": urgent_assigned[:cap], "unassigned": urgent_unassigned[:cap]},
        "regular": {"assigned": reg_assigned[:cap], "unassigned": reg_unassigned[:cap]},
        "meta": {
            "limit": cap,
            "truncated": any(len(lst) > cap for lst in lists),
            "totals": totals,
        },
    }


@router.post("/tasks/reset")
async def reset_tasks() -> dict:
    deps.store.reset_tasks()
    return {"result": "Reset successful"}


@router.post("/tasks/cancel/{cap}/{id}")
async def cancel_task(cap: str, id: str) -> dict:
    task_id = TaskId(cap=cap, id=id)
    task = deps.store.request_cancel(task_id)
    if task is None:
        raise AppError.not_found(str(task_id))
    return {"id": task_id.model_dump(by_alias=True), "status": task.status.value}


# ── agents ──────────────────────────────────────────────────────────────────


@router.get("/agents/list")
async def list_agents() -> list:
    return [a.model_dump(by_alias=True) for a in deps.store.list_agents()]


@router.get("/agents/list/online")
async def list_agents_online() -> list:
    return [a.model_dump(by_alias=True) for a in deps.store.list_online_agents()]


@router.post("/agents/reset")
async def reset_agents() -> dict:
    deps.store.clear_agents()
    return {"result": "Reset successful"}


@router.post("/agents/delete/{agent_id}")
async def remove_agent(agent_id: str) -> str:
    deps.store.delete_agent(agent_id)
    return "Agent deleted"


@router.post("/agents/cleanup/trigger")
async def trigger_stale_agents_cleanup() -> dict:
    return {"deleted": 0, "ttl_days": settings.stale_agents_ttl_days}


# ── client API keys ─────────────────────────────────────────────────────────


@router.get("/client_api_keys/list")
async def client_api_keys() -> list:
    return [k.model_dump(by_alias=True) for k in deps.store.list_keys()]


@router.post("/client_api_keys/update")
async def add_client_api_key(req: CreateApiKeyRequest) -> dict:
    key = ClientApiKey(
        key=req.key,
        capabilities=req.capabilities,
        is_predefined=False,
        created=now_utc(),
        is_revoked=False,
    )
    deps.store.upsert_key(key)
    return key.model_dump(by_alias=True)


@router.post("/client_api_keys/revoke/{id}")
async def revoke_client_api_key(id: str) -> dict:
    key = deps.store.revoke_key(id)
    if key is None:
        raise AppError.not_found(id)
    return key.model_dump(by_alias=True)


# ── service logs (empty) ────────────────────────────────────────────────────


@router.get("/service_logs")
async def list_service_messages(
    class_: str = Query(..., alias="class"),
    limit: Optional[int] = None,
    cursor: Optional[str] = None,
) -> dict:
    return {"class": class_, "items": [], "next_cursor": None, "count": 0}


# ── heuristics (empty) ──────────────────────────────────────────────────────


@router.get("/heuristics/records")
async def heuristics_records(
    capability: Optional[str] = None,
    runner_id: Optional[str] = None,
    machine_id: Optional[str] = None,
    limit: Optional[int] = None,
    cursor: Optional[str] = None,
) -> dict:
    return {"items": [], "count": 0, "next_cursor": None}


@router.get("/heuristics/stats/runners")
async def heuristics_runner_stats() -> dict:
    return {"items": [], "count": 0}


@router.get("/heuristics/stats/machines")
async def heuristics_machine_stats() -> dict:
    return {"items": [], "count": 0}


@router.get("/heuristics/estimate_duration")
async def heuristics_estimate_duration(
    capability: str = Query(...), machine_id: str = Query(...)
) -> dict:
    return {"capability": capability, "machineId": machine_id, "estimatedMs": None}


@router.post("/heuristics/cleanup/trigger")
async def trigger_heuristics_cleanup() -> dict:
    return {
        "deleted_by_age": 0,
        "deleted_by_limit": 0,
        "ttl_days": settings.heuristics_ttl_days,
        "max_records_per_runner_cap": settings.heuristics_max_records_per_runner_cap,
    }


# ── storage admin ───────────────────────────────────────────────────────────


@router.get("/storage/buckets")
async def list_all_buckets() -> dict:
    by_key: dict[str, dict] = {}
    for bucket in deps.store.list_all_buckets():
        entry = by_key.setdefault(
            bucket.api_key,
            {"bucket_count": 0, "total_files": 0, "total_bytes": 0, "buckets": []},
        )
        entry["bucket_count"] += 1
        entry["total_files"] += len(bucket.files)
        entry["total_bytes"] += bucket.used_bytes
        entry["buckets"].append(
            {
                "bucket_uid": bucket.uid,
                "created_at": iso_z(bucket.created_at),
                "file_count": len(bucket.files),
                "used_bytes": bucket.used_bytes,
                "tasks": bucket.tasks,
            }
        )
    return {"buckets_by_key": by_key}


@router.get("/storage/quotas")
async def get_quotas(api_key: Optional[str] = None) -> dict:
    cfg = settings.storage
    limits = {
        "max_buckets_per_key": cfg.max_buckets_per_key,
        "bucket_size_bytes": cfg.bucket_size_bytes,
        "bucket_ttl_minutes": cfg.bucket_ttl_minutes,
    }
    usage: dict[str, dict] = {}
    if api_key is not None:
        buckets = deps.store.list_buckets_for_key(api_key)
        usage[api_key] = {
            "bucket_count": len(buckets),
            "total_bytes": sum(b.used_bytes for b in buckets),
            "total_files": sum(len(b.files) for b in buckets),
        }
    else:
        for bucket in deps.store.list_all_buckets():
            entry = usage.setdefault(
                bucket.api_key, {"bucket_count": 0, "total_bytes": 0, "total_files": 0}
            )
            entry["bucket_count"] += 1
            entry["total_bytes"] += bucket.used_bytes
            entry["total_files"] += len(bucket.files)
    return {"limits": limits, "usage": usage}


@router.delete("/storage/bucket/{bucket_uid}")
async def delete_bucket(bucket_uid: str) -> dict:
    if deps.store.get_bucket(bucket_uid) is None:
        raise AppError.not_found(f"Bucket {bucket_uid} not found")
    deps.store.delete_bucket(bucket_uid)
    return {"deleted_bucket_uid": bucket_uid}


@router.delete("/storage/key/{api_key}/buckets")
async def delete_key_buckets(api_key: str) -> dict:
    buckets = deps.store.list_buckets_for_key(api_key)
    for bucket in buckets:
        deps.store.delete_bucket(bucket.uid)
    return {"api_key": api_key, "deleted_count": len(buckets)}


@router.post("/storage/cleanup/trigger")
async def trigger_storage_cleanup() -> dict:
    expired = deps.store.expired_buckets(settings.storage.bucket_ttl_minutes)
    for bucket in expired:
        deps.store.delete_bucket(bucket.uid)
    return {"deleted_count": len(expired)}


@router.delete("/storage/buckets")
async def purge_all_buckets() -> dict:
    buckets = deps.store.list_all_buckets()
    count = len(buckets)
    for bucket in buckets:
        deps.store.delete_bucket(bucket.uid)
    return {"deleted_count": count}
