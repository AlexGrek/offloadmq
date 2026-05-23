"""REST API router factory — closes over the injected orchestrator."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ui_server.protocol import OrchestratorAPI


class SettingsPayload(BaseModel):
    server: str | None = None
    api_key: str | None = None
    capabilities: list[str] | None = None
    custom_caps: list[str] | None = None
    tier: int | None = None
    max_concurrent: int | None = None
    autostart: bool | None = None


def _dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")


def create_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter(prefix="/api")

    # ------------------------------------------------------------------
    # Settings
    # ------------------------------------------------------------------

    @router.get("/settings")
    def get_settings() -> dict[str, Any]:
        return _dump(orch.get_settings())

    @router.post("/settings")
    def post_settings(payload: SettingsPayload) -> dict[str, Any]:
        fields = {k: v for k, v in payload.model_dump().items() if v is not None}
        return _dump(orch.update_settings(**fields))

    # ------------------------------------------------------------------
    # Capabilities
    # ------------------------------------------------------------------

    @router.get("/capabilities/detect")
    def detect() -> dict[str, list[str]]:
        return {"capabilities": orch.scan_capabilities()}

    # ------------------------------------------------------------------
    # Agent lifecycle
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Tasks
    # ------------------------------------------------------------------

    @router.get("/tasks")
    def list_tasks() -> dict[str, Any]:
        return {"tasks": [_dump(t) for t in orch.list_tasks()]}

    @router.get("/tasks/{task_id}")
    def get_task(task_id: str) -> dict[str, Any]:
        record = orch.get_task(task_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Task not found")
        return _dump(record)

    @router.post("/tasks/{task_id}/cancel")
    def cancel_task(task_id: str) -> dict[str, Any]:
        ok = orch.cancel_task(task_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Task not active")
        return {"ok": True}

    return router
