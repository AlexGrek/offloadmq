"""FastAPI router — all /api/* endpoints."""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from offloadmq_agent.agent import Agent
from offloadmq_agent.capabilities import detect_capabilities
from offloadmq_agent.config import AgentConfig, load_config, save_config

from ui_server.state import agent_state

router = APIRouter(prefix="/api")


# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------


class ConfigPayload(BaseModel):
    server: str = ""
    api_key: str = ""
    capabilities: list[str] = []
    custom_caps: list[str] = []
    tier: int = 1
    capacity: int = 4
    autostart: bool = False


@router.get("/config")
async def get_config() -> dict[str, Any]:
    cfg = load_config()
    return cfg.model_dump()


@router.post("/config")
async def post_config(payload: ConfigPayload) -> dict[str, Any]:
    cfg = load_config()
    cfg.server = payload.server
    cfg.api_key = payload.api_key
    cfg.capabilities = payload.capabilities
    cfg.custom_caps = payload.custom_caps
    cfg.tier = payload.tier
    cfg.capacity = payload.capacity
    cfg.autostart = payload.autostart
    save_config(cfg)
    return {"ok": True}


# ------------------------------------------------------------------
# Agent control
# ------------------------------------------------------------------


@router.post("/agent/start")
async def start_agent() -> dict[str, Any]:
    async with agent_state._lock:
        if agent_state.running:
            return {"ok": True, "message": "already running"}

        cfg = load_config()
        if not cfg.is_configured:
            raise HTTPException(status_code=400, detail="Agent is not configured")

        agent = Agent(cfg)
        agent.set_log_handler(agent_state.append_log)

        async def _run() -> None:
            agent_state.running = True
            try:
                await agent.start()
            except Exception as exc:
                agent_state.append_log(f"[agent] Fatal: {exc}")
            finally:
                agent_state.running = False

        task = asyncio.create_task(_run())
        agent_state._task = task

    return {"ok": True}


@router.post("/agent/stop")
async def stop_agent() -> dict[str, Any]:
    async with agent_state._lock:
        task = agent_state._task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        agent_state.running = False
        agent_state._task = None
    return {"ok": True}


@router.get("/agent/status")
async def agent_status() -> dict[str, Any]:
    return agent_state.snapshot()


@router.get("/agent/logs")
async def agent_logs(since: int = 0) -> dict[str, Any]:
    logs = list(agent_state.logs)
    return {"logs": logs[since:], "total": len(logs)}


# ------------------------------------------------------------------
# Capabilities
# ------------------------------------------------------------------


@router.get("/capabilities/detect")
async def capabilities_detect() -> dict[str, Any]:
    caps = await detect_capabilities()
    return {"capabilities": caps}


# ------------------------------------------------------------------
# WebSocket — live log stream
# ------------------------------------------------------------------


@router.websocket("/ws/logs")
async def ws_logs(websocket: WebSocket) -> None:
    await websocket.accept()
    sent = 0
    try:
        while True:
            logs = list(agent_state.logs)
            if len(logs) > sent:
                for line in logs[sent:]:
                    await websocket.send_text(line)
                sent = len(logs)
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        pass
