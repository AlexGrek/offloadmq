"""world.pano360 routes — configure / verify the FLUX models and install the WorldGen LoRA.

The LoRA (35 MB) is the only download; the orchestrator runs it as a background
job whose log tail is polled via ``GET /pano360/status``.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ui_server.protocol import OrchestratorAPI
from ui_server.schemas import Pano360InstallPayload, Pano360SettingsPayload


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    def guarded(fn: Any, *args: Any) -> dict[str, Any]:
        try:
            result: dict[str, Any] = fn(*args)
            return result
        except (RuntimeError, ValueError) as exc:  # Pano360InstallError
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.get("/pano360/status")
    def pano360_status() -> dict[str, Any]:
        return orch.get_pano360_status()

    @router.post("/pano360/settings")
    def pano360_settings(payload: Pano360SettingsPayload) -> dict[str, Any]:
        return guarded(
            orch.update_pano360_settings,
            payload.pano360_unet, payload.pano360_clip_l, payload.pano360_t5,
            payload.pano360_vae, payload.pano360_lora_dir,
        )

    @router.post("/pano360/install")
    def pano360_install(payload: Pano360InstallPayload) -> dict[str, Any]:
        return guarded(orch.start_pano360_install, payload.force)

    @router.post("/pano360/doctor")
    def pano360_doctor() -> dict[str, Any]:
        return guarded(orch.run_pano360_doctor)

    @router.post("/pano360/repair")
    def pano360_repair() -> dict[str, Any]:
        return guarded(orch.start_pano360_repair)

    @router.post("/pano360/uninstall")
    def pano360_uninstall() -> dict[str, Any]:
        return guarded(orch.start_pano360_uninstall)

    @router.post("/pano360/cancel")
    def pano360_cancel() -> dict[str, Any]:
        return orch.cancel_pano360_job()

    return router
