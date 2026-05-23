"""Orchestrator — the single object both CLI and GUI drive.

Owns settings, the task store, the threaded executor pool and the polling loop.
The polling loop runs in a dedicated thread with its own asyncio event loop so
aiohttp stays happy; executors run in separate pool threads.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from pathlib import Path
from typing import Any

from offloadmq_agent.capabilities import detect_capabilities
from offloadmq_agent.client import OffloadMQClient, OffloadMQError
from offloadmq_agent.executor import find as find_executor
from offloadmq_agent.models import LogEntry, LogLevel, Task, TaskResult, TaskStatus

from offloadmq_core.executor_pool import ExecutorPool
from offloadmq_core.settings import SETTINGS_FILE, Settings, load_settings, save_settings
from offloadmq_core.task_store import TaskRecord, TaskStore

logger = logging.getLogger(__name__)

_TOKEN_REFRESH_MARGIN = 300  # refresh JWT this many seconds before expiry
_POLL_INTERVAL = 2.0


class Orchestrator:
    def __init__(self, settings_path: Path = SETTINGS_FILE) -> None:
        self._settings_path = settings_path
        self._settings = load_settings(settings_path)
        self._store = TaskStore()
        self._lock = threading.Lock()

        self._pool: ExecutorPool | None = None
        self._client: OffloadMQClient | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._poller: threading.Thread | None = None
        self._stop = threading.Event()
        self._running = False
        self._online = False
        self._status_message = "stopped"

    # ==================================================================
    # Settings
    # ==================================================================

    def get_settings(self) -> Settings:
        with self._lock:
            return self._settings.model_copy(deep=True)

    def update_settings(self, **fields: Any) -> Settings:
        with self._lock:
            data = self._settings.model_dump()
            for key, value in fields.items():
                if key in data and value is not None:
                    data[key] = value
            self._settings = Settings.model_validate(data)
            save_settings(self._settings, self._settings_path)
            return self._settings.model_copy(deep=True)

    # ==================================================================
    # Capabilities
    # ==================================================================

    def scan_capabilities(self) -> list[str]:
        return asyncio.run(detect_capabilities())

    # ==================================================================
    # Registration (standalone — start() also registers)
    # ==================================================================

    def register(self) -> str:
        settings = self.get_settings()
        if not settings.is_configured:
            raise RuntimeError("Agent is not configured (server/api_key missing)")

        async def _do() -> tuple[Any, Any]:
            reg = await OffloadMQClient.register(
                settings.server,
                settings.api_key,
                settings.all_capabilities,
                settings.tier,
                settings.max_concurrent,
            )
            auth = await OffloadMQClient.authenticate(
                settings.server, reg.agent_id, reg.key
            )
            return reg, auth

        reg, auth = asyncio.run(_do())
        self.update_settings(
            agent_id=reg.agent_id,
            key=reg.key,
            jwt_token=auth.token,
            token_expires_in=auth.expires_in,
        )
        return str(reg.agent_id)

    # ==================================================================
    # Agent lifecycle
    # ==================================================================

    def start(self) -> None:
        with self._lock:
            if self._running:
                return
            settings = self._settings
            if not settings.is_configured:
                raise RuntimeError("Agent is not configured (server/api_key missing)")

            self._stop.clear()
            self._pool = ExecutorPool(max_workers=settings.max_concurrent)
            self._running = True
            self._status_message = "starting"
            self._poller = threading.Thread(
                target=self._poller_main, name="omq-poller", daemon=True
            )
            self._poller.start()

    def stop(self) -> None:
        with self._lock:
            if not self._running:
                return
            self._stop.set()
            pool = self._pool
            self._running = False
            self._online = False
            self._status_message = "stopped"
        if pool is not None:
            pool.shutdown(wait=False)

    def is_running(self) -> bool:
        with self._lock:
            return self._running

    def status(self) -> dict[str, Any]:
        with self._lock:
            settings = self._settings
            return {
                "running": self._running,
                "online": self._online,
                "message": self._status_message,
                "agentId": settings.agent_id,
                "server": settings.server,
                "capabilities": settings.all_capabilities,
                "maxConcurrent": settings.max_concurrent,
                "activeTasks": self._store.active_count(),
            }

    # ==================================================================
    # Task queries (delegate to store)
    # ==================================================================

    def list_tasks(self) -> list[TaskRecord]:
        return self._store.list()

    def get_task(self, task_id: str) -> TaskRecord | None:
        return self._store.get(task_id)

    def cancel_task(self, task_id: str) -> bool:
        return self._store.request_cancel(task_id)

    # ==================================================================
    # Polling thread
    # ==================================================================

    def _poller_main(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._run())
        except Exception as exc:  # noqa: BLE001
            logger.exception("poller crashed")
            self._set_message(f"crashed: {exc}")
        finally:
            loop.close()
            self._loop = None
            with self._lock:
                self._running = False
                self._online = False

    async def _run(self) -> None:
        settings = self.get_settings()
        self._set_message("registering")

        registration = await OffloadMQClient.register(
            settings.server,
            settings.api_key,
            settings.all_capabilities,
            settings.tier,
            settings.max_concurrent,
        )
        auth = await OffloadMQClient.authenticate(
            settings.server, registration.agent_id, registration.key
        )
        self.update_settings(
            agent_id=registration.agent_id,
            key=registration.key,
            jwt_token=auth.token,
            token_expires_in=auth.expires_in,
        )
        self._client = OffloadMQClient(settings.server, auth.token)
        with self._lock:
            self._online = True
        self._set_message("polling")

        await self._poll_loop(auth.expires_in)

    async def _poll_loop(self, token_expires_in: int) -> None:
        client = self._client
        assert client is not None
        settings = self.get_settings()
        caps = settings.all_capabilities

        while not self._stop.is_set():
            try:
                token_expires_in = await self._maybe_refresh(token_expires_in)

                if self._store.active_count() >= settings.max_concurrent:
                    await self._idle()
                    continue

                task = await client.poll(caps)
                if task is None:
                    await self._idle()
                    continue

                if not await client.take(task.capability, task.id):
                    continue

                self._dispatch(task)
            except OffloadMQError as exc:
                self._set_message(f"offloadmq error: {exc}")
                await asyncio.sleep(5)
            except Exception as exc:  # noqa: BLE001
                logger.exception("poll loop error")
                self._set_message(f"error: {exc}")
                await asyncio.sleep(5)

    async def _idle(self) -> None:
        await asyncio.sleep(_POLL_INTERVAL)

    async def _maybe_refresh(self, expires_in: int) -> int:
        if expires_in - int(time.time()) > _TOKEN_REFRESH_MARGIN:
            return expires_in
        settings = self.get_settings()
        auth = await OffloadMQClient.authenticate(
            settings.server, settings.agent_id, settings.key
        )
        self.update_settings(jwt_token=auth.token, token_expires_in=auth.expires_in)
        if self._client:
            self._client.update_token(auth.token)
        return auth.expires_in

    # ==================================================================
    # Dispatch + callbacks (callbacks run on pool worker threads)
    # ==================================================================

    def _dispatch(self, task: Task) -> None:
        executor = find_executor(task.capability)
        record, cancel_event = self._store.create(task)

        if executor is None:
            result = TaskResult(
                task_id=task.id,
                status=TaskStatus.FAILED,
                error=f"No executor registered for '{task.capability}'",
            )
            self._store.append_log(
                task.id,
                LogEntry(level=LogLevel.ERROR, message=result.error or ""),
            )
            self._store.finish(task.id, result)
            self._schedule_resolve(task, result)
            return

        pool = self._pool
        assert pool is not None
        self._set_message(f"running {task.id}")
        pool.submit(
            task,
            executor,
            cancel_event,
            self._on_log,
            self._on_done,
        )

    def _on_log(self, task_id: str, entry: LogEntry) -> None:
        self._store.append_log(task_id, entry)

    def _on_done(self, task: Task, result: TaskResult) -> None:
        self._store.finish(task.id, result)
        self._schedule_resolve(task, result)
        self._set_message("polling")

    def _schedule_resolve(self, task: Task, result: TaskResult) -> None:
        loop = self._loop
        client = self._client
        if loop is None or client is None:
            return
        asyncio.run_coroutine_threadsafe(
            self._safe_resolve(client, task.capability, result), loop
        )

    async def _safe_resolve(
        self, client: OffloadMQClient, capability: str, result: TaskResult
    ) -> None:
        try:
            await client.resolve(capability, result)
        except OffloadMQError as exc:
            logger.warning("resolve failed for %s: %s", result.task_id, exc)

    def _set_message(self, msg: str) -> None:
        with self._lock:
            self._status_message = msg
