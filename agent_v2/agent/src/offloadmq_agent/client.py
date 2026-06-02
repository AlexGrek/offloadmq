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
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        body: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class OffloadMQClient:
    """Thin async wrapper around the OffloadMQ agent HTTP API."""

    def __init__(self, server: str, jwt_token: str, timeout: int = 30) -> None:
        self._server = server.rstrip("/")
        self._jwt_token = jwt_token
        self._timeout = aiohttp.ClientTimeout(total=timeout)
        self._client_session: aiohttp.ClientSession | None = None

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._jwt_token}"}

    async def _session(self) -> aiohttp.ClientSession:
        if self._client_session is None or self._client_session.closed:
            self._client_session = aiohttp.ClientSession(timeout=self._timeout)
        return self._client_session

    async def close(self) -> None:
        if self._client_session is not None and not self._client_session.closed:
            await self._client_session.close()
        self._client_session = None

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
        url = f"{server.rstrip('/')}/agent/register"
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
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.post(url, json=payload) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise OffloadMQError(
                        f"Registration failed ({resp.status}): {text}",
                        status=resp.status,
                        body=text,
                    )
                data: dict[str, Any] = await resp.json()
                return AgentRegistration(agent_id=data["agentId"], key=data["key"])

    @staticmethod
    async def authenticate(server: str, agent_id: str, key: str) -> AgentAuth:
        url = f"{server.rstrip('/')}/agent/auth"
        payload = {"agentId": agent_id, "key": key}
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
            async with session.post(url, json=payload) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise OffloadMQError(
                        f"Auth failed ({resp.status}): {text}",
                        status=resp.status,
                        body=text,
                    )
                data: dict[str, Any] = await resp.json()
                return AgentAuth(token=data["token"], expires_in=data["expiresIn"])

    async def _parse_poll(self, resp: aiohttp.ClientResponse) -> Task | None:
        if resp.status == 204:
            return None
        if resp.status != 200:
            text = await resp.text()
            raise OffloadMQError(
                f"Poll failed ({resp.status}): {text}",
                status=resp.status,
                body=text,
            )
        raw = await resp.json()
        if raw is None:
            return None
        return Task.from_poll(raw)

    async def ping(self) -> None:
        url = f"{self._server}/private/agent/ping"
        session = await self._session()
        async with session.get(url, headers=self._headers()) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise OffloadMQError(
                        f"Ping failed ({resp.status}): {text}",
                        status=resp.status,
                        body=text,
                    )

    async def poll(self, capabilities: list[str]) -> Task | None:
        url = f"{self._server}/private/agent/task/poll"
        session = await self._session()
        async with session.get(
            url,
            params={"caps": ",".join(capabilities)},
            headers=self._headers(),
        ) as resp:
            return await self._parse_poll(resp)

    async def poll_urgent(self, capabilities: list[str]) -> Task | None:
        url = f"{self._server}/private/agent/task/poll_urgent"
        session = await self._session()
        async with session.get(
            url,
            params={"caps": ",".join(capabilities)},
            headers=self._headers(),
        ) as resp:
            return await self._parse_poll(resp)

    async def take(self, capability: str, task_id: str) -> bool:
        url = f"{self._server}/private/agent/take/{capability}/{task_id}"
        session = await self._session()
        async with session.post(url, headers=self._headers()) as resp:
            return resp.status == 200

    async def report_progress(
        self,
        capability: str,
        task_id: str,
        stage: str,
        log: str,
    ) -> None:
        url = f"{self._server}/private/agent/task/progress/{capability}/{task_id}"
        session = await self._session()
        async with session.post(
            url,
            json={"stage": stage, "log": log},
            headers=self._headers(),
        ) as resp:
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
        session = await self._session()
        async with session.post(url, json=body, headers=self._headers()) as resp:
            if resp.status not in (200, 204):
                text = await resp.text()
                raise OffloadMQError(
                    f"Update info failed ({resp.status}): {text}",
                    status=resp.status,
                    body=text,
                )

    async def resolve(self, capability: str, result: TaskResult) -> None:
        from offloadmq_agent.result_convert import task_result_to_wire

        url = f"{self._server}/private/agent/task/resolve/{capability}/{result.task_id}"
        payload = task_result_to_wire(result.task_id, capability, result)
        session = await self._session()
        async with session.post(url, json=payload, headers=self._headers()) as resp:
            if resp.status not in (200, 204):
                text = await resp.text()
                raise OffloadMQError(
                    f"Resolve failed ({resp.status}): {text}",
                    status=resp.status,
                    body=text,
                )

    def update_token(self, jwt_token: str) -> None:
        self._jwt_token = jwt_token

    async def submit_log(
        self,
        severity: str,
        text: str,
        *,
        agent_id: str | None = None,
        agent_name: str | None = None,
        machine_fingerprint: str | None = None,
    ) -> None:
        """POST a single runtime log to the server.

        Severity must be one of CRITICAL, ERROR, INFO. The server stamps the
        timestamp and record id; missing identity fields fall back to the
        authenticated agent record server-side.
        """
        url = f"{self._server}/private/agent/logs"
        body: dict[str, Any] = {"severity": severity, "text": text}
        if agent_id:
            body["agentId"] = agent_id
        if agent_name:
            body["agentName"] = agent_name
        if machine_fingerprint:
            body["machineFingerprint"] = machine_fingerprint
        session = await self._session()
        async with session.post(url, json=body, headers=self._headers()) as resp:
            if resp.status not in (200, 201, 204):
                text_body = await resp.text()
                raise OffloadMQError(
                    f"Submit log failed ({resp.status}): {text_body}",
                    status=resp.status,
                    body=text_body,
                )
