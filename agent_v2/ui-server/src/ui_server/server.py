"""FastAPI application factory."""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from ui_server.api import router


def _static_dir() -> Path:
    # PyInstaller extraction root or source tree.
    if getattr(sys, "frozen", False):
        base = Path(sys._MEIPASS)  # type: ignore[attr-defined]
    else:
        base = Path(__file__).parent.parent.parent  # ui-server/
    return base / "frontend" / "dist"


def create_app() -> FastAPI:
    app = FastAPI(title="OffloadMQ Agent UI", version="2.0.0")
    app.include_router(router)

    static = _static_dir()
    if static.exists():
        # Serve React SPA — any unmatched path falls back to index.html.
        app.mount("/", StaticFiles(directory=str(static), html=True), name="static")

    return app
