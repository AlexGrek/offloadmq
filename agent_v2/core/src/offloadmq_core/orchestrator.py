"""Orchestrator — the single object both CLI and GUI drive.

Design contract
---------------

The orchestrator's job is to keep the agent *always connected*. Once
``start()`` is called, the only thing that should stop the agent talking to the
server is ``stop()``. Anything else — DNS hiccups, expired tokens, the server
restarting, the API key being rotated server-side — is a transient condition
that the supervisor recovers from with exponential backoff.

Every failure along the way (connection, auth, registration, poll, resolve,
executor crash, …) is recorded in an in-memory :class:`ErrorPool` with a
severity. The moment the supervisor secures a fresh authenticated session, the
pool is flushed to the server's ``/private/agent/logs`` endpoint, so an
operator looking at the management UI can see *why* the agent was offline
without having to SSH into the machine.
"""
from __future__ import annotations

import asyncio
import logging
import random
import threading
import traceback
from pathlib import Path
from typing import Any

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
from offloadmq_core.error_pool import ErrorPool, PendingLog, Severity
from offloadmq_core.executor_pool import ExecutorPool
from offloadmq_core.scan_state import ScanState
from offloadmq_core.settings import SETTINGS_FILE, Settings, load_settings, save_settings
from offloadmq_core.task_store import TaskRecord, TaskStore

logger = logging.getLogger(__name__)

_RESCAN_BURST_INTERVAL = 30   # seconds between rescans during startup burst
_RESCAN_BURST_DURATION = 300  # 5-minute burst window after start
APP_VERSION = "2.0.0"

# Reconnect backoff: 2 → 4 → 8 → … capped at 60s. Reset on a successful auth.
_RECONNECT_BACKOFF_BASE = 2.0
_RECONNECT_BACKOFF_CAP = 60.0

# Agent→server heartbeat cadence: a fresh random delay in [min, max] seconds is
# rolled before every beat, mirroring the server's own 60–90s heartbeat. The beat
# runs on the session event loop independently of job execution (jobs run on pool
# worker threads), so the agent keeps heartbeating even while busy with a task.
_WS_HEARTBEAT_MIN_SECS = 60.0
_WS_HEARTBEAT_MAX_SECS = 90.0


class _SessionEnded(Exception):
    """Raised internally to signal the current session must restart.

    The exception carries a hint on whether saved credentials should be
    discarded (forcing a fresh ``register`` call) before reconnecting.
    """

    def __init__(self, message: str, *, reregister: bool = False) -> None:
        super().__init__(message)
        self.reregister = reregister


class Orchestrator:
    # Fields that, when changed while online, require pushing fresh info to the server.
    _SERVER_FACING = {
        "capabilities",
        "custom_caps",
        "display_name",
        "max_concurrent",
        "regular_disabled_caps",
        "sensitive_allowed_caps",
        "slavemode_allowed_caps",
    }
    # Fields that require a full re-registration when changed while running.
    _CONNECTION_FIELDS = {"server", "api_key"}

    def __init__(self, settings_path: Path = SETTINGS_FILE) -> None:
        self._settings_path = settings_path
        self._settings = load_settings(settings_path)
        self._store = TaskStore()
        self._lock = threading.Lock()
        self._logs = AgentLogBuffer()
        self._scan = ScanState()
        self._errors = ErrorPool()

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
        self._skipped_rescans: int = 0
        self._rescan_guard = threading.Lock()

    # ==================================================================
    # Local logging + error pool
    # ==================================================================

    def _log(self, msg: str) -> None:
        self._logs.append(msg)
        logger.info(msg)

    def _record_error(
        self,
        severity: Severity,
        text: str,
        *,
        exc: BaseException | None = None,
    ) -> None:
        """Stash an error for the server and surface it in the local log.

        If a client session is already authenticated, fire off the log
        immediately; otherwise it stays in the pool until reconnect.
        """
        full = text
        if exc is not None:
            # `exc` formatting is best-effort — we never want recording an
            # error to itself raise.
            try:
                tb = "".join(traceback.format_exception_only(type(exc), exc)).strip()
                full = f"{text}: {tb}" if text else tb
            except Exception:  # noqa: BLE001
                full = f"{text}: {exc!r}"
        self._logs.append(f"[{severity}] {full}")
        logger.log(
            logging.CRITICAL if severity == "CRITICAL"
            else logging.ERROR if severity == "ERROR"
            else logging.INFO,
            "%s",
            full,
        )
        self._errors.push(severity, full)
        # Opportunistic immediate flush when we're already online.
        loop = self._loop
        client = self._client
        if self._online and loop is not None and loop.is_running() and client is not None:
            asyncio.run_coroutine_threadsafe(self._flush_error_pool(client), loop)

    def _flush_error_pool_dropped_summary(self, dropped: int) -> PendingLog | None:
        if dropped <= 0:
            return None
        return PendingLog(
            severity="ERROR",
            text=f"error pool overflowed: {dropped} earlier entries dropped",
        )

    async def _flush_error_pool(self, client: OffloadMQClient) -> None:
        """Send everything in the pool. Items that fail to send go back."""
        items, dropped = self._errors.drain()
        if not items and dropped == 0:
            return
        summary = self._flush_error_pool_dropped_summary(dropped)
        to_send: list[PendingLog] = ([summary] if summary else []) + items

        settings = self.get_settings()
        agent_id = settings.agent_id or None
        agent_name = settings.display_name or None
        machine_fp: str | None = None
        try:
            sysinfo = collect_system_info()
            machine_fp = sysinfo.get("machineId") or None
        except Exception:  # noqa: BLE001
            machine_fp = None

        unsent: list[PendingLog] = []
        for entry in to_send:
            try:
                await client.submit_log(
                    entry.severity,
                    entry.render(),
                    agent_id=agent_id,
                    agent_name=agent_name,
                    machine_fingerprint=machine_fp,
                )
            except OffloadMQError as exc:
                logger.warning("log flush failed (will retry): %s", exc)
                # Whatever was not yet sent stays in the pool. Don't keep
                # retrying inside this call — the next successful op will
                # trigger another flush.
                idx = to_send.index(entry)
                unsent = to_send[idx:]
                break
            except Exception as exc:  # noqa: BLE001
                logger.warning("log flush hit unexpected error: %s", exc)
                idx = to_send.index(entry)
                unsent = to_send[idx:]
                break
        if unsent:
            self._errors.restore(unsent)

    # ==================================================================
    # Capability policy helpers
    # ==================================================================

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
        before = self.get_settings()
        with self._lock:
            self._settings = cfg
            save_settings(cfg, self._settings_path)
            after = cfg.model_copy(deep=True)
        self._apply_live(before, after)
        return after

    def apply_settings(self, **fields: Any) -> Settings:
        """User-facing settings update: persist, then apply live to the running agent."""
        before = self.get_settings()
        after = self.update_settings(**fields)
        self._apply_live(before, after)
        return after

    def _apply_live(self, before: Settings, after: Settings) -> None:
        changed = {
            name
            for name in type(after).model_fields
            if getattr(before, name) != getattr(after, name)
        }
        if not changed:
            return
        if "max_concurrent" in changed:
            self._resize_pool(after.max_concurrent)
        if changed & self._CONNECTION_FIELDS and self.is_running():
            # Connection settings changed → drop the current session; the
            # supervisor reconnects with the new values automatically.
            self._record_error(
                "INFO",
                "[settings] server or api_key changed — cycling connection",
            )
            self._cycle_session()
            return
        if changed & self._SERVER_FACING and self._online:
            self.push_capabilities_to_server()
        if "keep_awake_enabled" in changed:
            from offloadmq_core import keep_awake

            keep_awake.sync_from_settings(after.keep_awake_enabled, self._log)

    def _resize_pool(self, max_workers: int) -> None:
        with self._lock:
            old = self._pool
            if old is None:
                return
            self._pool = ExecutorPool(max_workers=max_workers)
        old.shutdown(wait=False)

    def _cycle_session(self) -> None:
        """Force the current session to end so the supervisor reconnects.

        Unlike ``stop()`` this leaves ``_running`` True — the supervisor loop
        keeps looping and picks up the new settings on the next iteration.
        """
        with self._lock:
            self._online = False
            self._status_message = "reconnecting"
        # Closing the underlying aiohttp session causes any in-flight or
        # subsequent calls to fail, which the supervisor catches.
        loop = self._loop
        client = self._client
        if loop is not None and loop.is_running() and client is not None:
            asyncio.run_coroutine_threadsafe(client.close(), loop)

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
                self._record_error("ERROR", "[scan] background scan failed", exc=exc)
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
            # No longer a full stop/start — just cycle the live session.
            self._cycle_session()
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
        return self.apply_settings(**fields)

    def push_capabilities_to_server(self) -> None:
        loop = self._loop
        if loop is None or not loop.is_running():
            return
        asyncio.run_coroutine_threadsafe(self._push_capabilities_async(), loop)

    async def _push_capabilities_async(self) -> None:
        client = self._client
        if client is None:
            return
        try:
            settings = self.get_settings()
            detected = self._last_detected or await detect_capabilities(self._log)
            caps = self._registration_caps(settings, detected)
            sysinfo = collect_system_info()
            tier = calculate_tier(sysinfo)
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
        except OffloadMQError as exc:
            self._record_error("ERROR", "[caps] push failed", exc=exc)
        except Exception as exc:  # noqa: BLE001
            self._record_error("ERROR", "[caps] push hit unexpected error", exc=exc)

    # ==================================================================
    # Registration (one-shot, used by `omq register`)
    # ==================================================================

    def register(self) -> str:
        settings = self.get_settings()
        if not settings.is_configured:
            raise RuntimeError("Agent is not configured (server/api_key missing)")

        async def _do() -> tuple[AgentRegistration, AgentAuth, list[str], list[str]]:
            detected = await detect_capabilities(self._log)
            caps = self._registration_caps(settings, detected)
            sysinfo = collect_system_info()
            tier = calculate_tier(sysinfo)
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
                target=self._supervisor_main, name="omq-supervisor", daemon=True
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
        # Wake the supervisor out of any sleep / aiohttp call.
        loop = self._loop
        client = self._client
        if loop is not None and loop.is_running() and client is not None:
            asyncio.run_coroutine_threadsafe(client.close(), loop)
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
                "errorPool": len(self._errors),
            }

    def get_agent_logs(self, n: int = 100) -> list[str]:
        return self._logs.tail(n)

    def get_error_pool_snapshot(self) -> list[dict[str, Any]]:
        return [
            {
                "severity": item.severity,
                "text": item.text,
                "capturedAt": item.captured_at.isoformat(),
            }
            for item in self._errors.snapshot()
        ]

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
    # Supervisor: stays alive across reconnects forever
    # ==================================================================

    def _supervisor_main(self) -> None:
        """Owning thread for the agent's network loop.

        Loops until ``stop()`` is called. Each iteration tries to bring up a
        single connected session via :meth:`_run_session`; if that returns or
        raises for any reason other than ``stop``, the supervisor sleeps with
        exponential backoff and tries again. The loop body itself is wrapped
        so even a programming error in our own code cannot terminate the
        supervisor.
        """
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)

        attempt = 0
        try:
            while not self._stop.is_set():
                try:
                    loop.run_until_complete(self._run_session())
                    # Clean session exit (e.g. _cycle_session) → reconnect immediately.
                    attempt = 0
                except _SessionEnded as ended:
                    if ended.reregister:
                        self._record_error(
                            "ERROR",
                            "[supervisor] discarding saved credentials, will re-register",
                        )
                        self.update_settings(
                            agent_id="", key="", jwt_token="", token_expires_in=0
                        )
                    # Don't count "cycle" as a backoff trigger.
                    attempt = 0
                except OffloadMQError as exc:
                    status = exc.status or 0
                    sev: Severity = "ERROR" if status == 0 or status >= 500 else "CRITICAL"
                    self._record_error(sev, "[supervisor] server error", exc=exc)
                    attempt += 1
                except Exception as exc:  # noqa: BLE001
                    self._record_error(
                        "CRITICAL", "[supervisor] unexpected error", exc=exc
                    )
                    attempt += 1

                with self._lock:
                    self._online = False
                    self._client = None
                    self._sync_transport = None

                if self._stop.is_set():
                    break

                delay = self._backoff_seconds(attempt)
                self._set_message(f"reconnecting in {delay:.0f}s")
                # Interruptible wait — stop() and _cycle_session() both wake us.
                if self._stop.wait(delay):
                    break
        finally:
            client = self._client
            if client is not None:
                try:
                    loop.run_until_complete(client.close())
                except Exception:  # noqa: BLE001
                    logger.debug("failed to close client session cleanly")
            loop.close()
            self._loop = None
            with self._lock:
                self._running = False
                self._online = False
                self._client = None
                self._sync_transport = None
                self._status_message = "stopped"

    @staticmethod
    def _backoff_seconds(attempt: int) -> float:
        if attempt <= 0:
            return 0.0
        delay = _RECONNECT_BACKOFF_BASE * (2 ** (attempt - 1))
        return min(delay, _RECONNECT_BACKOFF_CAP)

    async def _run_session(self) -> None:
        """Bring up a connected session and run the poll loop inside it.

        Returns normally if the session ends cleanly (e.g. settings cycle).
        Raises :class:`_SessionEnded` when we need the supervisor to take an
        explicit action (like clearing credentials) before reconnecting.
        """
        settings = self.get_settings()
        if not settings.is_configured:
            # Misconfigured — wait and let the user fix settings live.
            self._record_error(
                "ERROR", "[supervisor] agent is not configured (server/api_key missing)"
            )
            await asyncio.sleep(5)
            return

        try:
            client, auth_token, auth_expires_in = await self._connect(settings)
        except OffloadMQError as exc:
            # Authentication-class errors: forget creds so the next attempt
            # registers fresh. Anything else: just retry with the same creds.
            if exc.status in (401, 403):
                raise _SessionEnded(str(exc), reregister=True) from exc
            self._record_error(
                "ERROR" if (exc.status is None or exc.status >= 500) else "CRITICAL",
                "[connect] failed",
                exc=exc,
            )
            raise

        with self._lock:
            self._client = client
            self._sync_transport = SyncAgentTransport(settings.server, auth_token)
            self._online = True
        self._set_message("connecting")
        self._record_error("INFO", "[supervisor] agent online")

        # Flush anything that piled up while we were disconnected.
        await self._flush_error_pool(client)

        try:
            await self._ws_loop(client)
        finally:
            # _ws_loop owns the connection's lifetime; close on the way out.
            try:
                await client.close()
            except Exception:  # noqa: BLE001
                pass

    async def _connect(
        self, settings: Settings
    ) -> tuple[OffloadMQClient, str, int]:
        """Register/auth and push current capabilities. Raises on hard failure."""
        self._set_message("registering")
        detected = await detect_capabilities(self._log)
        caps = self._registration_caps(settings, detected)
        sysinfo = collect_system_info()
        tier = calculate_tier(sysinfo)

        auth: AgentAuth | None = None
        if settings.agent_id and settings.key:
            try:
                self._set_message("authenticating")
                auth = await OffloadMQClient.authenticate(
                    settings.server, settings.agent_id, settings.key
                )
            except OffloadMQError as exc:
                if exc.status in (401, 403):
                    self._record_error(
                        "ERROR",
                        "[auth] saved credentials rejected — will register fresh",
                        exc=exc,
                    )
                    auth = None
                else:
                    # Transient — let the supervisor back off.
                    raise

        if auth is None:
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
        else:
            self.update_settings(
                jwt_token=auth.token,
                token_expires_in=auth.expires_in,
                capabilities=[c for c in caps if not c.startswith("slavemode.")],
            )

        with self._lock:
            self._last_detected = detected

        client = OffloadMQClient(settings.server, auth.token)
        await client.update_agent_info(
            caps,
            tier,
            settings.max_concurrent,
            display_name=settings.display_name or "",
            system_info=sysinfo,
            app_version=APP_VERSION,
        )
        return client, auth.token, auth.expires_in

    async def _ws_loop(self, client: OffloadMQClient) -> None:
        """Receive pushed work over the WebSocket until the socket closes.

        The server *pushes* assigned tasks and proactive cancellations; the agent
        no longer polls. A clean socket close (server restart, network blip)
        returns normally so the supervisor reconnects with backoff. Capacity is
        enforced server-side — the server never pushes beyond the agent's
        registered ``capacity`` — so there is no client-side gate here.
        """
        await client.open_ws()
        self._set_message("online")

        # Heartbeat runs concurrently with the receive loop, on this same event
        # loop. Job execution happens on pool worker threads, so heartbeats keep
        # firing even while the agent is busy running a task.
        hb_task = asyncio.create_task(self._ws_heartbeat_loop(client))
        try:
            await self._ws_recv_loop(client)
        finally:
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass

        # Socket closed: return so the supervisor reconnects.
        self._set_message("disconnected")

    async def _ws_heartbeat_loop(self, client: OffloadMQClient) -> None:
        """Beat to the server every random 60–90s for the life of one session.

        A send failure means the socket is gone — stop quietly and let the
        receive loop's clean exit drive the supervisor's reconnect. Never touches
        ``_busy``/active-task state: the agent must heartbeat while jobs run.
        """
        while not self._stop.is_set():
            try:
                await asyncio.sleep(
                    random.uniform(_WS_HEARTBEAT_MIN_SECS, _WS_HEARTBEAT_MAX_SECS)
                )
            except asyncio.CancelledError:
                break
            if self._stop.is_set():
                break
            try:
                await client.send_heartbeat()
            except Exception:  # noqa: BLE001
                # Socket closed or transient — the receive loop ends and the
                # supervisor reconnects. Don't spam the error pool from here.
                break

    async def _ws_recv_loop(self, client: OffloadMQClient) -> None:
        async for msg in client.ws_messages():
            if self._stop.is_set():
                break
            mtype = msg.get("type")

            if mtype == "task":
                raw = msg.get("task")
                if not isinstance(raw, dict):
                    continue
                try:
                    task = Task.from_poll(raw)
                except Exception as exc:  # noqa: BLE001
                    self._record_error("ERROR", "[ws] malformed task push", exc=exc)
                    continue
                self._dispatch(task)

            elif mtype == "cancel":
                tid = msg.get("taskId")
                task_id = tid.get("id") if isinstance(tid, dict) else None
                if task_id:
                    self._store.request_cancel(str(task_id))
                    self._log(f"[ws] cancel requested for task {task_id}")

            elif mtype == "error":
                # An ack for one of our own RPC sends failed. 499 just means the
                # task was cancelled client-side — informational, not an error.
                err = msg.get("error") or {}
                if msg.get("status") == 499:
                    self._log(f"[ws] {err.get('message', 'task cancelled')}")
                else:
                    self._record_error(
                        "ERROR", f"[ws] server error: {err.get('message', err)}"
                    )

            elif mtype in ("connected", "heartbeat", "response"):
                # Liveness / RPC acks. Heartbeats are a good moment to drain any
                # error logs that piled up from background failures.
                if mtype == "heartbeat" and len(self._errors) > 0:
                    await self._flush_error_pool(client)
            # Unknown frame types are ignored.

    def _execute_rescan(self) -> None:
        """Run one rescan + server push. At most one runs at a time (guarded by _rescan_guard)."""
        if not self._rescan_guard.acquire(blocking=False):
            return
        try:
            self.rescan(restart_if_changed=False)
        except Exception as exc:  # noqa: BLE001
            self._record_error("ERROR", "[rescan] failed", exc=exc)
        finally:
            self._rescan_guard.release()

    def _trigger_rescan_async(self) -> None:
        """Spawn a background rescan thread; no-op if one is already running."""
        if self._rescan_guard.locked():
            return
        threading.Thread(target=self._execute_rescan, name="omq-rescan-bg", daemon=True).start()

    def _scheduler_maybe_rescan(self) -> None:
        """Called by the scheduler on each tick; tracks skipped cycles while busy."""
        if self._busy.is_set() or self._store.active_count() > 0:
            with self._lock:
                self._skipped_rescans += 1
            return
        with self._lock:
            self._skipped_rescans = 0
        self._execute_rescan()

    def _rescan_scheduler_main(self) -> None:
        burst_count = _RESCAN_BURST_DURATION // _RESCAN_BURST_INTERVAL
        for _ in range(burst_count):
            if self._stop.wait(_RESCAN_BURST_INTERVAL):
                return
            self._scheduler_maybe_rescan()
        while True:
            interval = float(self.get_settings().rescan_interval_secs)
            if self._stop.wait(interval):
                return
            self._scheduler_maybe_rescan()

    # ==================================================================
    # Dispatch
    # ==================================================================

    def _dispatch(self, task: Task) -> None:
        executor = find_executor(task.capability)
        record, cancel_event = self._store.create(task)

        if executor is None:
            msg = f"No executor registered for '{task.capability}'"
            result = TaskResult(task_id=task.id, status=TaskStatus.FAILED, error=msg)
            self._store.append_log(
                task.id, LogEntry(level=LogLevel.ERROR, message=msg)
            )
            self._store.finish(task.id, result)
            self._record_error(
                "ERROR", f"[dispatch] {msg} (task {task.id})"
            )
            self._schedule_resolve(task, result)
            return

        pool = self._pool
        assert pool is not None
        self._busy.set()
        self._set_message(f"running {task.id}")

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
        if result.status == TaskStatus.FAILED:
            self._record_error(
                "ERROR",
                f"[task] {task.capability}/{task.id} failed: {result.error or 'unknown error'}",
            )
        self._schedule_resolve(task, result)
        self._busy.clear()
        self._set_message("online")
        with self._lock:
            skipped = self._skipped_rescans
            self._skipped_rescans = 0
        if skipped > 0:
            self._trigger_rescan_async()

    def _schedule_resolve(self, task: Task, result: TaskResult) -> None:
        loop = self._loop
        client = self._client
        if loop is None or client is None:
            # Resolve will be retried via task store on next session — but
            # for now, record so the server learns about it once we reconnect.
            self._record_error(
                "ERROR",
                f"[resolve] no client to resolve task {task.capability}/{task.id}",
            )
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
            self._record_error(
                "ERROR",
                f"[resolve] failed for {capability}/{result.task_id}",
                exc=exc,
            )
        except Exception as exc:  # noqa: BLE001
            self._record_error(
                "ERROR",
                f"[resolve] unexpected error for {capability}/{result.task_id}",
                exc=exc,
            )

    def _set_message(self, msg: str) -> None:
        with self._lock:
            self._status_message = msg
