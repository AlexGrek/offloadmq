"""Top-level utility routes: /health, /stats, /version (mirror `main.rs`)."""

from __future__ import annotations

from fastapi import APIRouter

from .. import deps
from ..config import settings
from ..utils import iso_z, now_utc

router = APIRouter()


@router.get("/health")
async def health_check() -> dict:
    return {
        "status": "healthy",
        "agents": deps.store.agent_count(),
        "timestamp": iso_z(now_utc()),
    }


@router.get("/stats")
async def get_stats() -> dict:
    return {
        "agents": deps.store.agent_count(),
        "storage_paths": {
            "agents": "./data/agents",
            "tasks": "./data/tasks",
        },
    }


@router.get("/version")
async def version() -> dict:
    return {"version": settings.app_version}
