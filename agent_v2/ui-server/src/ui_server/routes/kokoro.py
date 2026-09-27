"""Kokoro TTS settings routes."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from offloadmq_agent.capabilities_sync import check_kokoro

from ui_server.protocol import OrchestratorAPI
from ui_server.schemas import KokoroSettingsPayload, dump


def build_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter()

    @router.post("/kokoro/settings")
    def kokoro_settings(payload: KokoroSettingsPayload) -> dict[str, Any]:
        result = dump(
            orch.apply_settings(
                kokoro_api_url=payload.kokoro_api_url.strip(),
                kokoro_api_key=payload.kokoro_api_key.strip(),
            )
        )
        orch.start_background_scan()
        return result

    @router.get("/kokoro/status")
    def kokoro_status() -> dict[str, Any]:
        r = check_kokoro()
        return {
            "ok": r.ok,
            "capabilities": r.caps,
            "reason": r.reason,
        }

    return router
