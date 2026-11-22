"""Background-removal routes — install / configure / verify the onnx.bgremove.* models.

Nothing is downloaded with the agent; these drive the orchestrator's background
job (log tail polled via ``GET /bgremove/status``).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ui_server.protocol import OrchestratorAPI
from ui_server.schemas import BgRemoveInstallPayload, BgRemoveSettingsPayload, BgRemoveUninstallPayload


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    def guarded(fn: Any, *args: Any) -> dict[str, Any]:
        try:
            result: dict[str, Any] = fn(*args)
            return result
        except (RuntimeError, ValueError) as exc:  # BgRemoveInstallError / BgRemoveConfigError
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.get("/bgremove/status")
    def bgremove_status() -> dict[str, Any]:
        return orch.get_bgremove_status()

    @router.post("/bgremove/settings")
    def bgremove_settings(payload: BgRemoveSettingsPayload) -> dict[str, Any]:
        return guarded(
            orch.update_bgremove_settings,
            payload.onnx_models_dir, payload.bgremove_device,
            payload.bgremove_threads, payload.bgremove_keep_loaded,
        )

    @router.post("/bgremove/install")
    def bgremove_install(payload: BgRemoveInstallPayload) -> dict[str, Any]:
        return guarded(orch.start_bgremove_install, payload.models or None, payload.force)

    @router.post("/bgremove/doctor")
    def bgremove_doctor() -> dict[str, Any]:
        return guarded(orch.run_bgremove_doctor)

    @router.post("/bgremove/repair")
    def bgremove_repair() -> dict[str, Any]:
        return guarded(orch.start_bgremove_repair)

    @router.post("/bgremove/uninstall")
    def bgremove_uninstall(payload: BgRemoveUninstallPayload) -> dict[str, Any]:
        return guarded(orch.start_bgremove_uninstall, payload.models or None)

    @router.post("/bgremove/cancel")
    def bgremove_cancel() -> dict[str, Any]:
        return orch.cancel_bgremove_job()

    return router
