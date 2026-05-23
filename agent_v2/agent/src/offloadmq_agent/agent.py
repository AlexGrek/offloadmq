"""Main async agent polling loop."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Callable, Coroutine

from offloadmq_agent.client import OffloadMQClient, OffloadMQError
from offloadmq_agent.config import AgentConfig, load_config, save_config
from offloadmq_agent.executor import find as find_executor
from offloadmq_agent.models import AgentAuth, Task, TaskResult, TaskStatus

logger = logging.getLogger(__name__)

# How many seconds before the JWT expiry to refresh the token.
_TOKEN_REFRESH_MARGIN = 300
_POLL_INTERVAL = 2.0
_MAX_WORKERS = 8


class Agent:
    """
    Async agent that registers with OffloadMQ, polls for tasks,
    and dispatches them to registered executors.
    """

    def __init__(self, config: AgentConfig | None = None) -> None:
        self._cfg = config or load_config()
        self._client: OffloadMQClient | None = None
        self._stop = asyncio.Event()
        self._active_tasks: set[asyncio.Task[None]] = set()
        self._on_log: Callable[[str], None] | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def set_log_handler(self, handler: Callable[[str], None]) -> None:
        self._on_log = handler

    async def start(self) -> None:
        """Register, authenticate, then run the polling loop until stop() is called."""
        self._stop.clear()
        cfg = self._cfg

        if not cfg.is_configured:
            raise RuntimeError("Agent is not configured (server/api_key missing)")

        self._log("[agent] Registering with OffloadMQ...")
        registration = await OffloadMQClient.register(
            cfg.server,
            cfg.api_key,
            cfg.all_capabilities,
            cfg.tier,
            cfg.capacity,
        )
        cfg.agent_id = registration.agent_id
        cfg.key = registration.key
        self._log(f"[agent] Registered as {cfg.agent_id}")

        auth = await OffloadMQClient.authenticate(cfg.server, cfg.agent_id, cfg.key)
        cfg.jwt_token = auth.token
        cfg.token_expires_in = auth.expires_in
        save_config(cfg)

        self._client = OffloadMQClient(cfg.server, cfg.jwt_token)
        self._log("[agent] Authenticated. Starting poll loop.")

        await self._poll_loop(auth)

    async def stop(self) -> None:
        self._stop.set()
        if self._active_tasks:
            await asyncio.gather(*self._active_tasks, return_exceptions=True)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _refresh_token_if_needed(self, auth: AgentAuth) -> AgentAuth:
        remaining = auth.expires_in - int(time.time())
        if remaining > _TOKEN_REFRESH_MARGIN:
            return auth
        self._log("[agent] Refreshing JWT token...")
        cfg = self._cfg
        new_auth = await OffloadMQClient.authenticate(cfg.server, cfg.agent_id, cfg.key)
        cfg.jwt_token = new_auth.token
        cfg.token_expires_in = new_auth.expires_in
        save_config(cfg)
        if self._client:
            self._client.update_token(new_auth.token)
        return new_auth

    async def _poll_loop(self, auth: AgentAuth) -> None:
        client = self._client
        assert client is not None
        caps = self._cfg.all_capabilities

        while not self._stop.is_set():
            try:
                auth = await self._refresh_token_if_needed(auth)
                task = await client.poll(caps)
                if task is None:
                    await asyncio.wait_for(
                        asyncio.shield(self._stop.wait()),
                        timeout=_POLL_INTERVAL,
                    )
                    continue

                if len(self._active_tasks) >= _MAX_WORKERS:
                    self._log("[agent] Worker pool full, skipping task")
                    await asyncio.sleep(_POLL_INTERVAL)
                    continue

                taken = await client.take(task.capability, task.id)
                if not taken:
                    continue

                self._log(f"[agent] Accepted task {task.id} ({task.capability})")
                worker = asyncio.create_task(self._run_task(task))
                self._active_tasks.add(worker)
                worker.add_done_callback(self._active_tasks.discard)

            except asyncio.TimeoutError:
                pass
            except OffloadMQError as exc:
                self._log(f"[agent] OffloadMQ error: {exc}")
                await asyncio.sleep(5)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._log(f"[agent] Unexpected error: {exc}")
                await asyncio.sleep(5)

    async def _run_task(self, task: Task) -> None:
        client = self._client
        assert client is not None

        executor = find_executor(task.capability)
        if executor is None:
            self._log(f"[agent] No executor for capability '{task.capability}'")
            result = TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                error=f"No executor registered for '{task.capability}'",
            )
            await client.resolve(task.capability, result)
            return

        async def report(stage: str, log: str) -> None:
            self._log(f"[{task.capability}] {stage}: {log}")
            await client.report_progress(task.capability, task.id, stage, log)

        try:
            result = await executor(task, report)
        except Exception as exc:
            self._log(f"[agent] Executor error for {task.id}: {exc}")
            result = TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                error=str(exc),
            )

        try:
            await client.resolve(task.capability, result)
            self._log(f"[agent] Resolved task {task.id} → {result.status}")
        except OffloadMQError as exc:
            self._log(f"[agent] Failed to resolve {task.id}: {exc}")

    def _log(self, msg: str) -> None:
        logger.info(msg)
        if self._on_log:
            self._on_log(msg)


@asynccontextmanager
async def run_agent(config: AgentConfig | None = None) -> AsyncIterator[Agent]:
    """Async context manager that starts the agent and stops it on exit."""
    agent = Agent(config)
    task = asyncio.create_task(agent.start())
    try:
        yield agent
    finally:
        await agent.stop()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
