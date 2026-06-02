"""Testing API: ``/testing/*`` — inject tasks into the mock queue.

The real OffloadMQ server has no equivalent surface — this exists solely so
test harnesses can drive a real agent through the full task lifecycle (poll →
take → progress → resolve) against the mock. Auth uses the same bearer
management token as ``/management/*``.

Endpoints
---------
* ``POST /testing/tasks/generate_for_capability`` — generate ``count`` synthetic
  tasks for a capability with randomized or override payloads.
* ``POST /testing/tasks/issue_slavemode_command`` — generate a single
  ``slavemode.*`` task. ``command`` accepts the bare suffix or the full cap.
* ``GET  /testing/tasks/list`` — inspect every injected task (compact shape).
* ``GET  /testing/tasks/{cap}/{id}`` — single task with status + result + logs.
* ``POST /testing/tasks/reset`` — drop every injected task.
* ``GET  /testing/templates`` — sample capabilities the generator understands
  plus the known slavemode command catalog.
"""

from __future__ import annotations

from typing import Any, List, Optional

from fastapi import APIRouter, Depends

from .. import deps
from ..config import settings
from ..errors import AppError
from ..schemas import (
    GenerateTasksRequest,
    IssueSlavemodeCommandRequest,
    TaskId,
    TaskSubmissionRequest,
)
from ..state import MockTask
from ..task_templates import (
    SLAVEMODE_PREFIX,
    generate_payload,
    known_capabilities,
    known_slavemode_commands,
    normalize_slavemode_capability,
    slavemode_default_payload,
)
from ..utils import now_utc, time_sortable_uid

router = APIRouter(dependencies=[Depends(deps.require_mgmt)])


def _default_api_key(explicit: Optional[str]) -> str:
    if explicit is not None:
        return explicit
    if not settings.client_api_keys:
        raise AppError.bad_request(
            "no client API keys configured; pass apiKey in the request body"
        )
    return settings.client_api_keys[0]


def _validate_target_agent(target: Optional[str]) -> None:
    if target is None:
        return
    if deps.store.get_agent(target) is None:
        raise AppError.not_found(f"agent {target!r} not registered")


def _build_task(
    *,
    capability: str,
    payload: Any,
    urgent: bool,
    restartable: bool,
    api_key: str,
    target_agent_id: Optional[str],
    source: str,
    timeout_secs: Optional[int] = None,
    max_wait_secs: Optional[int] = None,
    runtime_secs: Optional[int] = None,
    file_bucket: Optional[List[str]] = None,
    output_bucket: Optional[str] = None,
) -> MockTask:
    task_id = TaskId(cap=capability, id=time_sortable_uid())
    submission = TaskSubmissionRequest.model_validate(
        {
            "capability": capability,
            "urgent": urgent,
            "restartable": restartable,
            "payload": payload,
            "fetch_files": [],
            "file_bucket": list(file_bucket or []),
            "output_bucket": output_bucket,
            "timeoutSecs": timeout_secs,
            "maxWaitSecs": max_wait_secs,
            "runtimeSecs": runtime_secs,
            "artifacts": [],
            "data_preparation": {},
            "apiKey": api_key,
        }
    )
    return MockTask(
        id=task_id,
        data=submission,
        created_at=now_utc(),
        urgent=urgent,
        target_agent_id=target_agent_id,
        source=source,
    )


@router.post("/tasks/generate_for_capability")
async def generate_for_capability(req: GenerateTasksRequest) -> dict:
    if req.count < 1:
        raise AppError.bad_request("count must be >= 1")
    if req.count > 1000:
        raise AppError.bad_request("count must be <= 1000")
    api_key = _default_api_key(req.api_key)
    _validate_target_agent(req.target_agent_id)

    generated: list[dict] = []
    for _ in range(req.count):
        payload = (
            req.payload if req.payload is not None else generate_payload(req.capability, req.randomize)
        )
        task = _build_task(
            capability=req.capability,
            payload=payload,
            urgent=req.urgent,
            restartable=req.restartable,
            api_key=api_key,
            target_agent_id=req.target_agent_id,
            source="generate_for_capability",
            timeout_secs=req.timeout_secs,
            max_wait_secs=req.max_wait_secs,
            runtime_secs=req.runtime_secs,
            file_bucket=req.file_bucket,
            output_bucket=req.output_bucket,
        )
        deps.store.add_task(task)
        generated.append(
            {
                "id": task.id.model_dump(by_alias=True),
                "capability": task.id.cap,
                "urgent": task.urgent,
                "payload": payload,
            }
        )
    return {
        "capability": req.capability,
        "count": len(generated),
        "urgent": req.urgent,
        "targetAgentId": req.target_agent_id,
        "hasOnlineAgent": deps.store.has_online_agent_for(req.capability),
        "tasks": generated,
    }


@router.post("/tasks/issue_slavemode_command")
async def issue_slavemode_command(req: IssueSlavemodeCommandRequest) -> dict:
    capability = normalize_slavemode_capability(req.command)
    if not capability.startswith(SLAVEMODE_PREFIX):
        raise AppError.bad_request(
            f"command {req.command!r} is not a slavemode capability"
        )
    api_key = _default_api_key(req.api_key)
    _validate_target_agent(req.target_agent_id)
    payload = req.payload if req.payload is not None else slavemode_default_payload(capability)
    task = _build_task(
        capability=capability,
        payload=payload,
        urgent=req.urgent,
        restartable=False,
        api_key=api_key,
        target_agent_id=req.target_agent_id,
        source="issue_slavemode_command",
    )
    deps.store.add_task(task)
    return {
        "capability": capability,
        "command": capability.removeprefix(SLAVEMODE_PREFIX),
        "urgent": task.urgent,
        "targetAgentId": req.target_agent_id,
        "hasOnlineAgent": deps.store.has_online_agent_for(capability),
        "task": {
            "id": task.id.model_dump(by_alias=True),
            "payload": payload,
        },
    }


@router.get("/tasks/list")
async def list_testing_tasks() -> dict:
    tasks = [t.to_inspect_wire() for t in deps.store.list_tasks()]
    return {"count": len(tasks), "tasks": tasks}


@router.get("/tasks/{cap}/{id}")
async def get_testing_task(cap: str, id: str) -> dict:
    task = deps.store.get_task(TaskId(cap=cap, id=id))
    if task is None:
        raise AppError.not_found(str(TaskId(cap=cap, id=id)))
    return task.to_inspect_wire()


@router.post("/tasks/reset")
async def reset_testing_tasks() -> dict:
    return {"deleted": deps.store.reset_tasks()}


@router.get("/templates")
async def list_templates() -> dict:
    return {
        "capabilities": known_capabilities(),
        "slavemodeCommands": known_slavemode_commands(),
    }
