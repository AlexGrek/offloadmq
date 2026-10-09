"""Ollama settings routes."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from offloadmq_agent.capabilities_sync import check_ollama

from ui_server.protocol import OrchestratorAPI


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    @router.get("/ollama/status")
    def ollama_status() -> dict[str, Any]:
        r = check_ollama()
        return {"ok": r.ok, "capabilities": r.caps, "reason": r.reason}

    return router
