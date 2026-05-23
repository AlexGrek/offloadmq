"""Async HTTP client for the OffloadMQ agent API."""
from __future__ import annotations

from typing import Any

import aiohttp

from offloadmq_agent.models import (
    AgentAuth,
    AgentRegistration,
    Task,
    TaskResult,
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

    @staticmethod
    async def register(
        server: str,
        api_key: str,
        capabilities: list[str],
        tier: int,
        capacity: int,
        *,
        display_name: str = "",
        system_info: dict[str, Any] | None = None,
        app_version: str = "2.0.0",
    ) -> AgentRegistration:
        url = f"{server.rstrip('/')}/private/agent/register"
        payload: dict[str, Any] = {
            "apiKey": api_key,
            "capabilities": capabilities,
            "tier": tier,
            "capacity": capacity,
            "appVersion": app_version,
        }
        if system_info is not None:
            payload["systemInfo"] = system_info
        if display_name:
            payload["displayName"] = display_name[:50]
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

    async def _parse_poll(self, resp: aiohttp.ClientResponse) -> Task | None:
        if resp.status == 204:
            return None
        if resp.status != 200:
            text = await resp.text()
            raise OffloadMQError(f"Poll failed ({resp.status}): {text}")
        raw = await resp.json()
        if raw is None:
            return None
        return Task.from_poll(raw)

    async def poll(self, capabilities: list[str]) -> Task | None:
        url = f"{self._server}/private/agent/task/poll"
        async with await self._session() as session:
            async with session.get(url, params={"caps": ",".join(capabilities)}) as resp:
                return await self._parse_poll(resp)

    async def poll_urgent(self, capabilities: list[str]) -> Task | None:
        url = f"{self._server}/private/agent/task/poll_urgent"
        async with await self._session() as session:
            async with session.get(
                url, params={"caps": ",".join(capabilities)}
            ) as resp:
                return await self._parse_poll(resp)

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
                    pass

    async def update_agent_info(
        self,
        capabilities: list[str],
        tier: int,
        capacity: int,
        *,
        display_name: str = "",
        system_info: dict[str, Any] | None = None,
        app_version: str = "2.0.0",
    ) -> None:
        url = f"{self._server}/private/agent/info/update"
        body: dict[str, Any] = {
            "capabilities": capabilities,
            "tier": tier,
            "capacity": capacity,
            "appVersion": app_version,
        }
        if system_info is not None:
            body["systemInfo"] = system_info
        if display_name:
            body["displayName"] = display_name[:50]
        async with await self._session() as session:
            async with session.post(url, json=body) as resp:
                if resp.status not in (200, 204):
                    text = await resp.text()
                    raise OffloadMQError(f"Update info failed ({resp.status}): {text}")

    async def resolve(self, capability: str, result: TaskResult) -> None:
        from offloadmq_agent.result_convert import task_result_to_wire

        url = f"{self._server}/private/agent/task/resolve/{capability}/{result.task_id}"
        payload = task_result_to_wire(result.task_id, capability, result)
        async with await self._session() as session:
            async with session.post(url, json=payload) as resp:
                if resp.status not in (200, 204):
                    text = await resp.text()
                    raise OffloadMQError(f"Resolve failed ({resp.status}): {text}")

    def update_token(self, jwt_token: str) -> None:
        self._jwt_token = jwt_token
