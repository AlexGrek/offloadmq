"""REST API router factory — composes the per-concern routers in ``routes/``.

Each sub-router talks only to the injected ``orch: OrchestratorAPI`` — never to
``offloadmq_core`` directly (see SKILL.md's dependency graph: "ui-server ...
never imports core").
"""
from __future__ import annotations

from fastapi import APIRouter

from ui_server.protocol import OrchestratorAPI
from ui_server.routes import bgremove, comfy, core, custom_caps, kokoro, ollama, pano360, sharp, system


def create_router(orch: OrchestratorAPI) -> APIRouter:
    router = APIRouter(prefix="/api")
    for module in (core, custom_caps, comfy, kokoro, ollama, sharp, pano360, bgremove, system):
        router.include_router(module.build_router(orch))
    return router
