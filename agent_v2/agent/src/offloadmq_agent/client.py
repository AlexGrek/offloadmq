"""Async HTTP client for the OffloadMQ agent API."""
from __future__ import annotations

import asyncio
from typing import Any

import aiohttp

from offloadmq_agent.models import (
    AgentAuth,
    AgentRegistration,
    Task,
    TaskResult,
    TaskStatus,
)


class OffloadMQError(Exception):
    pass


class OffloadMQClient:
    """Thin async wrapper around the OffloadMQ agent HTTP API."""

    def __init__(self, server: str, jwt_token: str, timeout: int = 30) -> None:
        self._server = server.rstrip("/")
        self._jwt_token = jwt_token
        self._timeout = aiohttp.ClientTimeout(total=timeout)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._jwt_token}"}

    async def _session(self) -> aiohttp.ClientSession:
        return aiohttp.ClientSession(headers=self._headers(), timeout=self._timeout)

    # ------------------------------------------------------------------
    # Registration / Auth (static methods — no token needed)
    # ------------------------------------------------------------------

    @staticmethod
    async def register(
        server: str,
        api_key: str,
        capabilities: list[str],
        tier: int,
        capacity: int,
    ) -> AgentRegistration:
        url = f"{server.rstrip('/')}/private/agent/register"
        payload = {
            "apiKey": api_key,
            "capabilities": capabilities,
            "tier": tier,
            "capacity": capacity,
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise OffloadMQError(f"Registration failed ({resp.status}): {text}")
                data: dict[str, Any] = await resp.json()
                return AgentRegistration(agent_id=data["agentId"], key=data["key"])

    @staticmethod
    async def authenticate(server: str, agent_id: str, key: str) -> AgentAuth:
        url = f"{server.rstrip('/')}/private/agent/authenticate"
        payload = {"agentId": agent_id, "key": key}
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise OffloadMQError(f"Auth failed ({resp.status}): {text}")
                data: dict[str, Any] = await resp.json()
                return AgentAuth(token=data["token"], expires_in=data["expiresIn"])

    # ------------------------------------------------------------------
    # Task lifecycle
    # ------------------------------------------------------------------

    async def poll(self, capabilities: list[str]) -> Task | None:
        url = f"{self._server}/private/agent/task/poll"
        async with await self._session() as session:
            async with session.get(url, params={"caps": ",".join(capabilities)}) as resp:
                if resp.status == 204:
                    return None
                if resp.status != 200:
                    text = await resp.text()
                    raise OffloadMQError(f"Poll failed ({resp.status}): {text}")
                data: dict[str, Any] = await resp.json()
                return Task(
                    id=data["taskId"],
                    capability=data["capability"],
                    payload=data.get("payload", {}),
                )

    async def take(self, capability: str, task_id: str) -> bool:
        url = f"{self._server}/private/agent/take/{capability}/{task_id}"
        async with await self._session() as session:
            async with session.post(url) as resp:
                return resp.status == 200

    async def report_progress(
        self,
        capability: str,
        task_id: str,
        stage: str,
        log: str,
    ) -> None:
        url = f"{self._server}/private/agent/task/progress/{capability}/{task_id}"
        async with await self._session() as session:
            async with session.post(url, json={"stage": stage, "log": log}) as resp:
                if resp.status not in (200, 204):
                    pass  # progress failures are non-fatal

    async def resolve(self, capability: str, result: TaskResult) -> None:
        url = f"{self._server}/private/agent/task/resolve/{capability}/{result.task_id}"
        payload: dict[str, Any] = {
            "status": result.status.value,
            "output": result.output,
        }
        if result.error:
            payload["error"] = result.error
        async with await self._session() as session:
            async with session.post(url, json=payload) as resp:
                if resp.status not in (200, 204):
                    text = await resp.text()
                    raise OffloadMQError(f"Resolve failed ({resp.status}): {text}")

    async def poll_urgent(self, capabilities: list[str]) -> Task | None:
        url = f"{self._server}/private/agent/task/poll_urgent"
        async with await self._session() as session:
            async with session.get(url, params={"caps": ",".join(capabilities)}) as resp:
                if resp.status == 204:
                    return None
                if resp.status != 200:
                    return None
                data: dict[str, Any] = await resp.json()
                return Task(
                    id=data["taskId"],
                    capability=data["capability"],
                    payload=data.get("payload", {}),
                )

    # ------------------------------------------------------------------
    # Token refresh
    # ------------------------------------------------------------------

    def update_token(self, jwt_token: str) -> None:
        self._jwt_token = jwt_token
