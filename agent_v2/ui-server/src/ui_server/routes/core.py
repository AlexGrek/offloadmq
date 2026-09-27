"""Settings, capability policy, agent lifecycle, and task query routes."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ui_server.protocol import OrchestratorAPI
from ui_server.schemas import (
    CapabilityPolicyPayload,
    RawConfigPayload,
    RescanPayload,
    SettingsPayload,
    dump,
)


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    @router.get("/settings")
    def get_settings() -> dict[str, Any]:
        return dump(orch.get_settings())

    @router.post("/settings")
    def post_settings(payload: SettingsPayload) -> dict[str, Any]:
        fields = {k: v for k, v in payload.model_dump().items() if v is not None}
        return dump(orch.apply_settings(**fields))

    @router.get("/config/raw")
    def get_raw_config() -> dict[str, str]:
        return {"json": orch.get_raw_settings_json()}

    @router.post("/config/raw")
    def post_raw_config(payload: RawConfigPayload) -> dict[str, Any]:
        try:
            return dump(orch.save_raw_settings_json(payload.json_text))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.get("/capabilities/detect")
    def detect() -> dict[str, list[str]]:
        return {"capabilities": orch.scan_capabilities()}

    @router.get("/capabilities/state")
    def capabilities_state() -> dict[str, Any]:
        return orch.get_scan_state()

    @router.post("/capabilities/rescan")
    def rescan(payload: RescanPayload) -> dict[str, Any]:
        return orch.rescan(restart_if_changed=payload.restart_if_changed)

    @router.post("/capabilities/policy")
    def save_policy(payload: CapabilityPolicyPayload) -> dict[str, Any]:
        return dump(
            orch.update_capability_policy(
                regular_disabled=payload.regular_disabled,
                sensitive_allowed=payload.sensitive_allowed,
                slavemode_allowed=payload.slavemode_allowed,
            )
        )

    @router.post("/agent/start")
    def start() -> dict[str, Any]:
        try:
            orch.start()
        except RuntimeError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return orch.status()

    @router.post("/agent/stop")
    def stop() -> dict[str, Any]:
        orch.stop()
        return orch.status()

    @router.get("/agent/status")
    def status() -> dict[str, Any]:
        return orch.status()

    @router.get("/agent/logs")
    def agent_logs(n: int = Query(100, ge=1, le=500)) -> dict[str, list[str]]:
        return {"lines": orch.get_agent_logs(n)}

    @router.post("/agent/register")
    def register_agent() -> dict[str, str]:
        try:
            agent_id = orch.register()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"agentId": agent_id}

    @router.get("/tasks")
    def list_tasks() -> dict[str, Any]:
        return {"tasks": [dump(t) for t in orch.list_tasks()]}

    @router.get("/tasks/{task_id}")
    def get_task(task_id: str) -> dict[str, Any]:
        record = orch.get_task(task_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Task not found")
        return dump(record)

    @router.post("/tasks/{task_id}/cancel")
    def cancel_task(task_id: str) -> dict[str, Any]:
        ok = orch.cancel_task(task_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Task not active")
        return {"ok": True}

    return router
