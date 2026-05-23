"""Orchestrator — the single object both CLI and GUI drive."""
from __future__ import annotations

import asyncio
import itertools
import logging
import threading
import time
from pathlib import Path
from typing import Any, Callable

from offloadmq_agent.cap_policy import classify_capabilities, compute_registration_caps
from offloadmq_agent.capabilities import detect_capabilities
from offloadmq_agent.capabilities_sync import detect_capabilities as detect_capabilities_sync
from offloadmq_agent.client import OffloadMQClient, OffloadMQError
from offloadmq_agent.executor import find as find_executor
from offloadmq_agent.models import (
    AgentAuth,
    AgentRegistration,
    LogEntry,
    LogLevel,
    Task,
    TaskResult,
    TaskStatus,
)
from offloadmq_agent.slavemode_policy import ALL_SLAVEMODE_CAPS
from offloadmq_agent.systeminfo import calculate_tier, collect_system_info
from offloadmq_agent.transport_sync import SyncAgentTransport

from offloadmq_core.agent_log import AgentLogBuffer
from offloadmq_core.executor_pool import ExecutorPool
from offloadmq_core.scan_state import ScanState
from offloadmq_core.settings import SETTINGS_FILE, Settings, load_settings, save_settings
from offloadmq_core.task_store import TaskRecord, TaskStore

logger = logging.getLogger(__name__)

_TOKEN_REFRESH_MARGIN = 300
_POLL_INTERVAL = 2.0
_RESCAN_INTERVALS = [30, 120, 300]
_RESCAN_STEADY = 900
APP_VERSION = "2.0.0"


class Orchestrator:
    def __init__(self, settings_path: Path = SETTINGS_FILE) -> None:
        self._settings_path = settings_path
        self._settings = load_settings(settings_path)
        self._store = TaskStore()
        self._lock = threading.Lock()
        self._logs = AgentLogBuffer()
        self._scan = ScanState()

        self._pool: ExecutorPool | None = None
        self._client: OffloadMQClient | None = None
        self._sync_transport: SyncAgentTransport | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._poller: threading.Thread | None = None
        self._rescan_thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._busy = threading.Event()
        self._running = False
        self._online = False
        self._status_message = "stopped"
        self._last_detected: list[str] = []

    def _log(self, msg: str) -> None:
        self._logs.append(msg)
        logger.info(msg)

    def _settings_as_policy_dict(self, settings: Settings) -> dict[str, Any]:
        return settings.model_dump()

    def _registration_caps(self, settings: Settings, detected: list[str]) -> list[str]:
        cfg = self._settings_as_policy_dict(settings)
        caps = compute_registration_caps(cfg, detected, self._log)
        policy_updates = {
            k: cfg[k]
            for k in (
                "regular_disabled_caps",
                "sensitive_allowed_caps",
                "slavemode_allowed_caps",
                "onnx_slavemode_initialized",
            )
            if k in cfg
        }
        if policy_updates:
            self.update_settings(**policy_updates)
        return caps

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

    def get_raw_settings_json(self) -> str:
        return self.get_settings().model_dump_json(indent=2)

    def save_raw_settings_json(self, text: str) -> Settings:
        cfg = Settings.model_validate_json(text)
        with self._lock:
            self._settings = cfg
            save_settings(cfg, self._settings_path)
            return cfg.model_copy(deep=True)

    # ==================================================================
    # Capabilities / scan
    # ==================================================================

    def scan_capabilities(self) -> list[str]:
        return asyncio.run(detect_capabilities(self._log))

    def get_scan_state(self) -> dict[str, Any]:
        snap = self._scan.snapshot()
        settings = self.get_settings()
        classified = classify_capabilities(snap["caps"])
        return {
            **snap,
            "tierCaps": {
                "regular": classified["regular"],
                "sensitive": classified["sensitive"],
                "unknown": classified["unknown"],
                "regularDisabled": settings.regular_disabled_caps,
                "sensitiveAllowed": settings.sensitive_allowed_caps,
                "slavemodeAllowed": settings.slavemode_allowed_caps,
                "slavemodeAll": ALL_SLAVEMODE_CAPS,
            },
        }

    def start_background_scan(self) -> None:
        if self._scan.snapshot()["scanning"]:
            return
        self._scan.set_scanning(True)

        def _run() -> None:
            try:
                caps = detect_capabilities_sync(self._log)
                info = collect_system_info()
            except Exception as exc:  # noqa: BLE001
                self._log(f"[scan] error: {exc}")
                caps, info = [], {}
            self._scan.set_result(caps, info)
            with self._lock:
                self._last_detected = caps

        threading.Thread(target=_run, name="omq-scan", daemon=True).start()

    def rescan(self, *, restart_if_changed: bool = False) -> dict[str, Any]:
        was_running = self.is_running()
        caps = self.scan_capabilities()
        with self._lock:
            prev = list(self._last_detected)
            self._last_detected = caps
        info = collect_system_info()
        self._scan.set_result(caps, info)
        changed = set(caps) != set(prev)
        result: dict[str, Any] = {
            "capabilities": caps,
            "changed": changed,
            "restarted": False,
        }
        if restart_if_changed and changed and was_running:
            self.stop()
            self.start()
            result["restarted"] = True
        elif self._online and self._client is not None:
            self.push_capabilities_to_server()
        return result

    def update_capability_policy(
        self,
        *,
        regular_disabled: list[str] | None = None,
        sensitive_allowed: list[str] | None = None,
        slavemode_allowed: list[str] | None = None,
    ) -> Settings:
        fields: dict[str, Any] = {}
        if regular_disabled is not None:
            fields["regular_disabled_caps"] = regular_disabled
        if sensitive_allowed is not None:
            fields["sensitive_allowed_caps"] = sensitive_allowed
        if slavemode_allowed is not None:
            fields["slavemode_allowed_caps"] = slavemode_allowed
        settings = self.update_settings(**fields)
        if self._online:
            self.push_capabilities_to_server()
        return settings

    def push_capabilities_to_server(self) -> None:
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        asyncio.run_coroutine_threadsafe(self._push_capabilities_async(), loop)

    async def _push_capabilities_async(self) -> None:
        client = self._client
        if client is None:
            return
        settings = self.get_settings()
        detected = self._last_detected or await detect_capabilities(self._log)
        caps = self._registration_caps(settings, detected)
        sysinfo = collect_system_info()
        tier = settings.tier or calculate_tier(sysinfo)
        await client.update_agent_info(
            caps,
            tier,
            settings.max_concurrent,
            display_name=settings.display_name,
            system_info=sysinfo,
            app_version=APP_VERSION,
        )
        self.update_settings(capabilities=[c for c in caps if not c.startswith("slavemode.")])
        self._log(f"[caps] Pushed {len(caps)} capabilities to server")

    # ==================================================================
    # Registration
    # ==================================================================

    def register(self) -> str:
        settings = self.get_settings()
        if not settings.is_configured:
            raise RuntimeError("Agent is not configured (server/api_key missing)")

        async def _do() -> tuple[AgentRegistration, AgentAuth, list[str], list[str]]:
            detected = await detect_capabilities(self._log)
            caps = self._registration_caps(settings, detected)
            sysinfo = collect_system_info()
            tier = settings.tier or calculate_tier(sysinfo)
            reg = await OffloadMQClient.register(
                settings.server,
                settings.api_key,
                caps,
                tier,
                settings.max_concurrent,
                display_name=settings.display_name,
                system_info=sysinfo,
                app_version=APP_VERSION,
            )
            auth = await OffloadMQClient.authenticate(
                settings.server, reg.agent_id, reg.key
            )
            return reg, auth, caps, detected

        reg, auth, caps, detected = asyncio.run(_do())
        with self._lock:
            self._last_detected = detected
        self.update_settings(
            agent_id=reg.agent_id,
            key=reg.key,
            jwt_token=auth.token,
            token_expires_in=auth.expires_in,
            capabilities=[c for c in caps if not c.startswith("slavemode.")],
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
            self.start_background_scan()
            self._poller = threading.Thread(
                target=self._poller_main, name="omq-poller", daemon=True
            )
            self._poller.start()
            self._rescan_thread = threading.Thread(
                target=self._rescan_scheduler_main, name="omq-rescan", daemon=True
            )
            self._rescan_thread.start()

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
            snap = self._scan.snapshot()
            return {
                "running": self._running,
                "online": self._online,
                "message": self._status_message,
                "agentId": settings.agent_id,
                "server": settings.server,
                "capabilities": settings.all_capabilities,
                "maxConcurrent": settings.max_concurrent,
                "activeTasks": self._store.active_count(),
                "displayName": settings.display_name,
                "sysinfo": snap.get("sysinfo", {}),
                "scanning": snap.get("scanning", False),
            }

    def get_agent_logs(self, n: int = 100) -> list[str]:
        return self._logs.tail(n)

    # ==================================================================
    # Task queries
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

        detected = await detect_capabilities(self._log)
        caps = self._registration_caps(settings, detected)
        sysinfo = collect_system_info()
        tier = settings.tier or calculate_tier(sysinfo)

        registration = await OffloadMQClient.register(
            settings.server,
            settings.api_key,
            caps,
            tier,
            settings.max_concurrent,
            display_name=settings.display_name,
            system_info=sysinfo,
            app_version=APP_VERSION,
        )
        auth = await OffloadMQClient.authenticate(
            settings.server, registration.agent_id, registration.key
        )
        self.update_settings(
            agent_id=registration.agent_id,
            key=registration.key,
            jwt_token=auth.token,
            token_expires_in=auth.expires_in,
            capabilities=[c for c in caps if not c.startswith("slavemode.")],
        )
        with self._lock:
            self._last_detected = detected

        self._client = OffloadMQClient(settings.server, auth.token)
        self._sync_transport = SyncAgentTransport(settings.server, auth.token)
        with self._lock:
            self._online = True
        self._set_message("polling")
        await self._poll_loop(auth.expires_in)

    async def _poll_loop(self, token_expires_in: int) -> None:
        client = self._client
        assert client is not None
        settings = self.get_settings()
        caps = self._registration_caps(settings, self._last_detected)

        while not self._stop.is_set():
            try:
                token_expires_in = await self._maybe_refresh(token_expires_in)
                caps = self._registration_caps(self.get_settings(), self._last_detected)

                if self._store.active_count() >= settings.max_concurrent:
                    await self._idle()
                    continue

                task = await client.poll_urgent(caps)
                if task is None:
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
        if self._sync_transport:
            self._sync_transport = SyncAgentTransport(settings.server, auth.token)
        return auth.expires_in

    def _rescan_scheduler_main(self) -> None:
        schedule = itertools.chain(_RESCAN_INTERVALS, itertools.repeat(_RESCAN_STEADY))
        for interval in schedule:
            if self._stop.wait(interval):
                return
            if self._busy.is_set() or self._store.active_count() > 0:
                continue
            try:
                self.rescan(restart_if_changed=False)
            except Exception as exc:  # noqa: BLE001
                self._log(f"[rescan] failed: {exc}")

    # ==================================================================
    # Dispatch
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
        self._busy.set()
        self._set_message(f"running {task.id}")

        settings = self.get_settings()

        def progress_reporter(stage: str, message: str, _extra: str) -> None:
            self._store.append_log(
                task.id,
                LogEntry(level=LogLevel.PROGRESS, stage=stage, message=message),
            )
            loop = self._loop
            client = self._client
            if loop and client:
                asyncio.run_coroutine_threadsafe(
                    client.report_progress(task.capability, task.id, stage, message),
                    loop,
                )

        pool.submit(
            task,
            executor,
            cancel_event,
            self._on_log,
            self._on_done,
            progress_reporter=progress_reporter,
            agent_transport=self._sync_transport,
        )

    def _on_log(self, task_id: str, entry: LogEntry) -> None:
        self._store.append_log(task_id, entry)

    def _on_done(self, task: Task, result: TaskResult) -> None:
        self._store.finish(task.id, result)
        self._schedule_resolve(task, result)
        self._busy.clear()
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
