"""world.mirror routes — accept the licence, install / verify / remove the WorldMirror runtime.

Install and repair run as a background job whose log tail is polled via
``GET /mirror/status``.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ui_server.protocol import OrchestratorAPI
from ui_server.schemas import MirrorInstallPayload, MirrorSettingsPayload, MirrorUninstallPayload


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    def guarded(fn: Any, *args: Any) -> dict[str, Any]:
        try:
            result: dict[str, Any] = fn(*args)
            return result
        except (RuntimeError, ValueError) as exc:  # MirrorInstallError
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.get("/mirror/status")
    def mirror_status() -> dict[str, Any]:
        return orch.get_mirror_status()

    @router.post("/mirror/settings")
    def mirror_settings(payload: MirrorSettingsPayload) -> dict[str, Any]:
        return guarded(orch.update_mirror_settings, payload.mirror_dir, payload.mirror_license_accepted,
                       payload.mirror_free_ollama)

    @router.post("/mirror/install")
    def mirror_install(payload: MirrorInstallPayload) -> dict[str, Any]:
        return guarded(orch.start_mirror_install, payload.force)

    @router.post("/mirror/doctor")
    def mirror_doctor() -> dict[str, Any]:
        return guarded(orch.run_mirror_doctor)

    @router.post("/mirror/repair")
    def mirror_repair() -> dict[str, Any]:
        return guarded(orch.start_mirror_repair)

    @router.post("/mirror/uninstall")
    def mirror_uninstall(payload: MirrorUninstallPayload) -> dict[str, Any]:
        return guarded(orch.start_mirror_uninstall, payload.remove_models)

    @router.post("/mirror/cancel")
    def mirror_cancel() -> dict[str, Any]:
        return orch.cancel_mirror_job()

    return router
