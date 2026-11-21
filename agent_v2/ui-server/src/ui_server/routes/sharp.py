"""SHARP runtime routes — install / configure / remove the world.sharp backend.

Nothing is installed with the agent; these drive the orchestrator's background
install job (log tail polled via ``GET /sharp/status``).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ui_server.protocol import OrchestratorAPI
from ui_server.schemas import SharpInstallPayload, SharpSettingsPayload, SharpUninstallPayload


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    def guarded(fn: Any, *args: Any) -> dict[str, Any]:
        try:
            result: dict[str, Any] = fn(*args)
            return result
        except (RuntimeError, ValueError) as exc:  # SharpInstallError is a RuntimeError
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.get("/sharp/status")
    def sharp_status() -> dict[str, Any]:
        return orch.get_sharp_status()

    @router.post("/sharp/settings")
    def sharp_settings(payload: SharpSettingsPayload) -> dict[str, Any]:
        return guarded(
            orch.update_sharp_settings,
            payload.sharp_venv_dir, payload.sharp_models_dir, payload.sharp_torch_index,
        )

    @router.post("/sharp/install")
    def sharp_install(payload: SharpInstallPayload) -> dict[str, Any]:
        return guarded(orch.start_sharp_install, payload.force)

    @router.post("/sharp/doctor")
    def sharp_doctor() -> dict[str, Any]:
        return guarded(orch.run_sharp_doctor)

    @router.post("/sharp/repair")
    def sharp_repair() -> dict[str, Any]:
        return guarded(orch.start_sharp_repair)

    @router.post("/sharp/uninstall")
    def sharp_uninstall(payload: SharpUninstallPayload) -> dict[str, Any]:
        return guarded(orch.start_sharp_uninstall, payload.remove_models)

    @router.post("/sharp/cancel")
    def sharp_cancel() -> dict[str, Any]:
        return orch.cancel_sharp_job()

    return router
