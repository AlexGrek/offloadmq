"""FastAPI application factory."""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from ui_server.api import create_router
from ui_server.protocol import OrchestratorAPI


def _static_dir() -> Path:
    if getattr(sys, "frozen", False):
        base = Path(sys._MEIPASS)  # type: ignore[attr-defined]
        return base / "frontend" / "dist"
    return Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


def create_app(orchestrator: OrchestratorAPI) -> FastAPI:
    app = FastAPI(title="OffloadMQ Agent UI", version="2.0.0")
    app.include_router(create_router(orchestrator))

    @app.on_event("startup")
    async def _on_startup() -> None:
        if hasattr(orchestrator, "start_background_scan"):
            orchestrator.start_background_scan()
        settings = orchestrator.get_settings()
        autostart = getattr(settings, "autostart", False)
        if autostart and hasattr(orchestrator, "start"):
            try:
                orchestrator.start()
            except RuntimeError:
                pass

    static = _static_dir()
    if static.exists():
        # html=True gives SPA fallback (unmatched paths → index.html).
        app.mount("/", StaticFiles(directory=str(static), html=True), name="static")

    return app
