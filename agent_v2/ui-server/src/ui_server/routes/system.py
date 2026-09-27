"""System info, self-update, and OS startup-integration routes."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from offloadmq_agent.systeminfo import collect_system_info, effective_display_name

from ui_server.protocol import OrchestratorAPI
from ui_server.schemas import dump


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    @router.get("/system/info")
    def system_info() -> dict[str, Any]:
        return {"sysinfo": collect_system_info()}

    @router.get("/system/default-display-name")
    def default_display_name() -> dict[str, str]:
        sysinfo = collect_system_info()
        return {"display_name": effective_display_name("", sysinfo)}

    @router.get("/update/check")
    def update_check() -> dict[str, Any]:
        return orch.check_update()

    @router.post("/update/download")
    def update_download() -> dict[str, Any]:
        return orch.download_update()

    @router.get("/update/auto")
    def update_auto_status() -> dict[str, Any]:
        return orch.get_auto_update_status()

    @router.post("/update/auto/run")
    def update_auto_run() -> dict[str, Any]:
        if not orch.trigger_auto_update():
            raise HTTPException(
                status_code=400,
                detail=orch.get_auto_update_status().get("unsupported_reason")
                or "Auto-update is not running (start the agent first)",
            )
        return orch.get_auto_update_status()

    @router.get("/system/startup-status")
    def startup_status() -> dict[str, Any]:
        return orch.get_startup_status()

    @router.post("/system/keep-awake")
    def keep_awake_toggle(enable: bool = Query(...)) -> dict[str, Any]:
        try:
            settings = orch.set_keep_awake(enable)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return dump(settings)

    @router.post("/system/win-startup")
    def win_startup(enable: bool = Query(...)) -> dict[str, Any]:
        try:
            settings = orch.set_win_startup(enable)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return dump(settings)

    @router.post("/system/mac-startup")
    def mac_startup(enable: bool = Query(...)) -> dict[str, Any]:
        try:
            settings = orch.set_mac_startup(enable)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return dump(settings)

    @router.post("/system/install-systemd")
    def install_systemd(host: str | None = None, port: int | None = None) -> dict[str, Any]:
        # host/port defaults live on the orchestrator (core owns DEFAULT_WEBUI_PORT
        # and the loopback-only default) — ui-server never imports core directly.
        return orch.install_systemd(host, port)

    @router.post("/system/uninstall-systemd")
    def uninstall_systemd() -> dict[str, Any]:
        return orch.uninstall_systemd()

    return router
