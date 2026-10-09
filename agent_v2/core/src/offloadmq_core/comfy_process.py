"""Local ComfyUI server lifecycle — launch, stop, restart, crash watchdog.

The agent can own a ComfyUI process instead of relying on one started by hand
(or by Comfy Desktop). Ownership is narrow on purpose:

* Only a process this agent spawned — or one it spawned in a previous run and
  re-adopts from the pid file — is ever stopped or restarted. A ComfyUI that
  already answers on ``comfyui_url`` but isn't ours is reported as
  ``external`` and left alone (it also holds the port, so a spawn would fail).
* Crash restarts are rate-limited by :class:`RestartLimiter`: at most
  ``MAX_CRASH_RESTARTS`` within ``CRASH_WINDOW_SECS``. Past that the manager
  gives up (state ``crash-loop``) until someone starts it again by hand.
* The process tree is killed on agent exit (``atexit``). A hard exit (e.g. the
  self-updater's ``os._exit``) leaves it running; the pid file lets the next
  agent run adopt it instead of orphaning it.

``--port`` / ``--listen`` are derived from ``comfyui_url`` unless the operator
put them in ``comfyui_args`` — so the URL the executors talk to and the address
the server binds can't drift apart.
"""
from __future__ import annotations

import atexit
import collections
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import psutil

from offloadmq_core.error_pool import Severity
from offloadmq_core.settings import Settings

logger = logging.getLogger(__name__)

MAX_CRASH_RESTARTS = 5
CRASH_WINDOW_SECS = 20 * 60

_STATE_FILE = Path.home() / ".offloadmq-agent-comfy.json"
_WATCH_INTERVAL_SECS = 2.0
_CRASH_RESTART_DELAY_SECS = 5.0
_READY_PROBE_TIMEOUT_SECS = 2.0
_SLOW_START_WARN_SECS = 300.0
_STOP_TIMEOUT_SECS = 15.0
_OUTPUT_LINES = 400
_OUTPUT_TAIL_BYTES = 128 * 1024
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")  # ComfyUI colours its log levels

# States reported by status(). "external" is derived, never stored.
STOPPED = "stopped"
STARTING = "starting"
RUNNING = "running"
CRASHED = "crashed"
CRASH_LOOP = "crash-loop"
EXTERNAL = "external"


class RestartLimiter:
    """Sliding-window cap on automatic restarts."""

    def __init__(
        self,
        max_restarts: int = MAX_CRASH_RESTARTS,
        window_secs: float = CRASH_WINDOW_SECS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_restarts = max_restarts
        self.window_secs = window_secs
        self._clock = clock
        self._stamps: collections.deque[float] = collections.deque()

    def _prune(self) -> None:
        cutoff = self._clock() - self.window_secs
        while self._stamps and self._stamps[0] <= cutoff:
            self._stamps.popleft()

    def recent(self) -> int:
        self._prune()
        return len(self._stamps)

    def try_acquire(self) -> bool:
        """Record a restart and return True, or False if the window is full."""
        self._prune()
        if len(self._stamps) >= self.max_restarts:
            return False
        self._stamps.append(self._clock())
        return True

    def reset(self) -> None:
        self._stamps.clear()


def _url_host_port(url: str) -> tuple[str, int]:
    parsed = urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    if host == "localhost":
        host = "127.0.0.1"
    port = parsed.port or (443 if parsed.scheme == "https" else 8188)
    return host, port


def build_command(settings: Settings) -> list[str]:
    """The argv the manager would run for these settings."""
    args = list(settings.comfyui_args)
    host, port = _url_host_port(settings.comfyui_url)
    if "--port" not in args:
        args += ["--port", str(port)]
    if "--listen" not in args:
        args += ["--listen", host]
    return [settings.comfyui_python, "-s", settings.comfyui_main_py, *args]


def config_problem(settings: Settings) -> str | None:
    """Why the launch config can't be used, or None if it looks runnable."""
    if not settings.comfyui_python:
        return "Python executable is not set"
    if not Path(settings.comfyui_python).is_file():
        return f"Python executable not found: {settings.comfyui_python}"
    if not settings.comfyui_main_py:
        return "ComfyUI main.py path is not set"
    if not Path(settings.comfyui_main_py).is_file():
        return f"ComfyUI main.py not found: {settings.comfyui_main_py}"
    return None


def probe_ready(url: str, timeout: float = _READY_PROBE_TIMEOUT_SECS) -> bool:
    try:
        with urllib.request.urlopen(f"{url.rstrip('/')}/system_stats", timeout=timeout) as r:
            return bool(r.status == 200)
    except Exception:  # noqa: BLE001
        return False


def _kill_tree(proc: psutil.Process, timeout: float) -> None:
    """Terminate ``proc`` and all descendants (venv launchers spawn a child python)."""
    try:
        procs = [proc, *proc.children(recursive=True)]
    except psutil.Error:
        procs = [proc]
    for p in procs:
        try:
            p.terminate()
        except psutil.Error:
            pass
    _, alive = psutil.wait_procs(procs, timeout=timeout)
    for p in alive:
        try:
            p.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(alive, timeout=5)


class ComfyProcessManager:
    def __init__(
        self,
        get_settings: Callable[[], Settings],
        log: Callable[[str], None],
        report_error: Callable[[Severity, str], None],
        on_change: Callable[[], None],
        state_path: Path = _STATE_FILE,
    ) -> None:
        self._get_settings = get_settings
        self._log = log
        self._report_error = report_error
        self._on_change = on_change
        self._state_path = state_path
        # Output goes to a file, not a pipe: a pipe dies with the agent and an
        # orphaned ComfyUI would then crash on its next print. The file also
        # lets an adopted process keep showing its output.
        self._log_path = state_path.with_suffix(".log")

        self._lock = threading.RLock()
        self._proc: psutil.Process | None = None
        self._popen: subprocess.Popen[bytes] | None = None
        self._state = STOPPED
        self._want_running = False
        self._adopted = False
        self._started_at: float | None = None
        self._slow_warned = False
        self._last_exit_code: int | None = None
        self._last_error = ""
        self._limiter = RestartLimiter()
        self._activated = False

        self._shutdown = threading.Event()
        self._watchdog: threading.Thread | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def _activate(self) -> bool:
        """Take ownership duties: adopt a leftover process, stop ours at exit.

        Deferred until the agent is actually serving (autostart / an explicit
        start) — every short-lived ``omq`` subcommand builds an Orchestrator,
        and those must neither adopt nor kill a running ComfyUI on exit.
        Returns True on the first call only.
        """
        with self._lock:
            if self._activated:
                return False
            self._activated = True
        atexit.register(self.shutdown)
        self._adopt_from_state_file()
        return True

    def autostart(self) -> None:
        """Called when the agent app comes up; launches if ``comfyui_launch_on_startup``.

        Runs once per process: later agent start/stop cycles never relaunch a
        ComfyUI the operator stopped on purpose.
        """
        if not self._activate():
            return
        if not self._get_settings().comfyui_launch_on_startup:
            return
        with self._lock:
            if self._alive():
                return  # adopted from the previous run
        try:
            self.start()
        except (ValueError, OSError) as exc:
            self._report_error("ERROR", f"[comfy] launch on startup failed: {exc}")

    def start(self) -> dict[str, Any]:
        """Start ComfyUI (no-op if ours is already up). Raises ValueError on bad config."""
        self._activate()
        with self._lock:
            if self._alive():
                return self.status()
            settings = self._get_settings()
            if probe_ready(settings.comfyui_url):
                raise ValueError(
                    f"A ComfyUI not started by this agent is already answering at "
                    f"{settings.comfyui_url} — stop it first or change the ComfyUI URL"
                )
            problem = config_problem(settings)
            if problem:
                raise ValueError(problem)
            # A deliberate start clears any crash-loop lockout.
            self._limiter.reset()
            self._spawn(settings)
        return self.status()

    def stop(self) -> dict[str, Any]:
        self._activate()
        with self._lock:
            self._want_running = False
            proc = self._proc
        if proc is not None:
            self._log(f"[comfy] stopping ComfyUI (pid {proc.pid})")
            _kill_tree(proc, _STOP_TIMEOUT_SECS)
        with self._lock:
            # The watchdog may have seen the exit first; either way we're stopped.
            self._clear_process()
            self._state = STOPPED
        self._on_change()
        return self.status()

    def restart(self) -> dict[str, Any]:
        with self._lock:
            ours = self._alive()
        if ours:
            self.stop()
        return self.start()

    def wait_ready(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if self._state == RUNNING:
                    return True
                if not self._alive():
                    return False
            if self._shutdown.wait(1.0):
                return False
        return False

    def status(self) -> dict[str, Any]:
        settings = self._get_settings()
        with self._lock:
            ours = self._alive()
            state = self._state
            pid = self._proc.pid if self._proc is not None else None
            started = self._started_at
            adopted = self._adopted
            exit_code = self._last_exit_code
            last_error = self._last_error
            recent = self._limiter.recent()
        if not ours and state in (STOPPED, CRASHED) and probe_ready(settings.comfyui_url, 1.0):
            state = EXTERNAL
        return {
            "state": state,
            "managed": ours,
            "adopted": adopted,
            "pid": pid,
            "startedAt": (
                datetime.fromtimestamp(started, tz=timezone.utc).isoformat()
                if started and ours else None
            ),
            "lastExitCode": exit_code,
            "lastError": last_error,
            "restartsInWindow": recent,
            "maxRestarts": MAX_CRASH_RESTARTS,
            "windowMinutes": CRASH_WINDOW_SECS // 60,
            "url": settings.comfyui_url,
            "configProblem": config_problem(settings),
            "command": build_command(settings),
            "logPath": str(self._log_path),
            "output": self._tail_output(_OUTPUT_LINES),
        }

    def shutdown(self) -> None:
        """Stop the watchdog and our ComfyUI. Called at interpreter exit."""
        if self._shutdown.is_set():
            return
        self._shutdown.set()
        with self._lock:
            proc = self._proc
            self._want_running = False
        if proc is not None:
            try:
                _kill_tree(proc, _STOP_TIMEOUT_SECS)
            except Exception:  # noqa: BLE001
                logger.debug("failed to stop ComfyUI on shutdown", exc_info=True)
            with self._lock:
                self._clear_process()

    # ------------------------------------------------------------------
    # Internals (call with self._lock held unless noted)
    # ------------------------------------------------------------------

    def _alive(self) -> bool:
        proc = self._proc
        if proc is None:
            return False
        if self._popen is not None:
            return self._popen.poll() is None
        try:
            return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE
        except psutil.Error:
            return False

    def _spawn(self, settings: Settings) -> None:
        cmd = build_command(settings)
        main_py = Path(settings.comfyui_main_py)
        # ComfyUI resolves its own dirs relative to main.py, but custom nodes
        # sometimes assume CWD is the repo root.
        cwd = main_py.parent
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = (
                subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            )
        else:
            kwargs["start_new_session"] = True
        self._log(f"[comfy] launching: {subprocess.list2cmdline(cmd)}")
        # Truncated per launch; the child owns the handle from here on.
        with open(self._log_path, "wb") as out:
            popen = subprocess.Popen(
                cmd,
                cwd=str(cwd),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.STDOUT,
                **kwargs,
            )
        self._popen = popen
        self._proc = psutil.Process(popen.pid)
        self._adopted = False
        self._want_running = True
        self._state = STARTING
        self._started_at = time.time()
        self._slow_warned = False
        self._last_error = ""
        self._write_state_file()
        self._ensure_watchdog()

    def _tail_output(self, n: int) -> list[str]:
        """Last ``n`` non-empty lines of the ComfyUI log file."""
        try:
            with open(self._log_path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - _OUTPUT_TAIL_BYTES))
                chunk = f.read()
        except OSError:
            return []
        lines = _ANSI_RE.sub("", chunk.decode("utf-8", errors="replace")).splitlines()
        if size > _OUTPUT_TAIL_BYTES:
            lines = lines[1:]  # first line is likely cut mid-way
        return [ln for ln in lines if ln.strip()][-n:]

    def _clear_process(self) -> None:
        self._proc = None
        self._popen = None
        self._adopted = False
        self._started_at = None
        try:
            self._state_path.unlink(missing_ok=True)
        except OSError:
            pass

    def _write_state_file(self) -> None:
        proc = self._proc
        if proc is None:
            return
        try:
            data = {"pid": proc.pid, "createTime": proc.create_time()}
            self._state_path.write_text(json.dumps(data))
        except (OSError, psutil.Error):
            logger.debug("could not write ComfyUI state file", exc_info=True)

    def _adopt_from_state_file(self) -> None:
        """Re-attach to a ComfyUI a previous agent run spawned and left behind."""
        try:
            data = json.loads(self._state_path.read_text())
            pid = int(data["pid"])
            create_time = float(data["createTime"])
        except (OSError, ValueError, KeyError, TypeError):
            return
        try:
            proc = psutil.Process(pid)
            # Pid reuse guard: same pid, different process → not ours.
            if abs(proc.create_time() - create_time) > 1.0 or not proc.is_running():
                raise psutil.NoSuchProcess(pid)
        except psutil.Error:
            try:
                self._state_path.unlink(missing_ok=True)
            except OSError:
                pass
            return
        with self._lock:
            self._proc = proc
            self._popen = None
            self._adopted = True
            self._want_running = True
            self._state = STARTING
            self._started_at = create_time
            self._slow_warned = True  # it's been up a while; don't nag
        self._log(f"[comfy] adopted ComfyUI left running by a previous agent (pid {pid})")
        self._ensure_watchdog()

    def _ensure_watchdog(self) -> None:
        if self._watchdog is not None and self._watchdog.is_alive():
            return
        self._watchdog = threading.Thread(
            target=self._watch_main, name="omq-comfy-watch", daemon=True
        )
        self._watchdog.start()

    def _watch_main(self) -> None:
        while not self._shutdown.wait(_WATCH_INTERVAL_SECS):
            try:
                self._watch_tick()
            except Exception as exc:  # noqa: BLE001
                self._report_error("ERROR", f"[comfy] watchdog error: {exc!r}")

    def _watch_tick(self) -> None:
        with self._lock:
            if self._proc is None:
                return
            alive = self._alive()
            state = self._state
            want = self._want_running
        if alive:
            if state == STARTING:
                self._check_ready()
            return
        if not want:
            return  # stop() is in progress and owns the cleanup
        self._handle_crash()

    def _check_ready(self) -> None:
        settings = self._get_settings()
        if probe_ready(settings.comfyui_url):
            with self._lock:
                if self._state != STARTING:
                    return
                self._state = RUNNING
                self._last_error = ""
                took =time.time() - (self._started_at or time.time())
            self._log(f"[comfy] ComfyUI ready at {settings.comfyui_url} ({took:.0f}s)")
            self._on_change()
            return
        with self._lock:
            started_at = self._started_at
            if started_at is None or self._slow_warned:
                return
            if time.time() - started_at < _SLOW_START_WARN_SECS:
                return
            self._slow_warned = True
        self._fail(
            "ERROR",
            f"ComfyUI still not answering at {settings.comfyui_url} after "
            f"{_SLOW_START_WARN_SECS:.0f}s — check its output on the ComfyUI page",
        )

    def _handle_crash(self) -> None:
        with self._lock:
            popen = self._popen
            code = popen.poll() if popen is not None else None
            tail = self._tail_output(5)
            self._last_exit_code = code
            self._clear_process()
            was_running = self._state == RUNNING
            self._state = CRASHED
            self._want_running = False
        detail = f" (exit code {code})" if code is not None else ""
        last_lines = ("\n" + "\n".join(tail)) if tail else ""
        self._fail("ERROR", f"ComfyUI exited unexpectedly{detail}", extra=last_lines)
        if was_running:
            self._on_change()

        settings = self._get_settings()
        if not settings.comfyui_restart_on_crash:
            return
        with self._lock:
            allowed = self._limiter.try_acquire()
            count = self._limiter.recent()
            if not allowed:
                self._state = CRASH_LOOP
        if not allowed:
            self._fail(
                "CRITICAL",
                f"ComfyUI crashed {MAX_CRASH_RESTARTS} times within "
                f"{CRASH_WINDOW_SECS // 60} minutes — auto-restart suspended until started manually",
            )
            return
        if self._shutdown.wait(_CRASH_RESTART_DELAY_SECS):
            return
        problem = config_problem(settings)
        if problem:
            self._fail("ERROR", f"auto-restart skipped: {problem}")
            return
        with self._lock:
            if self._proc is not None or self._state != CRASHED:
                return  # someone started/stopped it meanwhile
            self._log(
                f"[comfy] auto-restarting after crash ({count}/{MAX_CRASH_RESTARTS} "
                f"in the last {CRASH_WINDOW_SECS // 60} min)"
            )
            try:
                self._spawn(settings)
                return
            except OSError as exc:
                failure = f"auto-restart failed: {exc}"
        self._fail("ERROR", failure)

    def _fail(self, severity: Severity, message: str, *, extra: str = "") -> None:
        """Record ``message`` as the last error (shown in the UI) and report it."""
        with self._lock:
            self._last_error = message
        self._report_error(severity, f"[comfy] {message}{extra}")


# ----------------------------------------------------------------------
# Install discovery (Comfy Desktop)
# ----------------------------------------------------------------------


def _desktop_data_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Comfy Desktop"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Comfy Desktop"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "Comfy Desktop"


def _venv_python(root: Path) -> Path:
    if sys.platform == "win32":
        return root / ".venv" / "Scripts" / "python.exe"
    return root / ".venv" / "bin" / "python"


def detect_desktop_install() -> dict[str, Any] | None:
    """Derive a launch config from a Comfy Desktop install, mirroring how Desktop runs it.

    Returns ``{python, mainPy, args, url, name, source}`` or None if no local
    install is registered with Comfy Desktop.
    """
    data_dir = _desktop_data_dir()
    try:
        installs = json.loads((data_dir / "installations.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    try:
        desktop_settings = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        desktop_settings = {}
    if not isinstance(installs, list):
        return None
    local = [
        i for i in installs
        if isinstance(i, dict) and i.get("installPath") and i.get("sourceId") != "cloud"
    ]
    # Most recently launched first.
    local.sort(key=lambda i: i.get("lastLaunchedAt") or 0, reverse=True)
    for inst in local:
        install_path = Path(inst["installPath"])
        main_py = install_path / "ComfyUI" / "main.py"
        if not main_py.is_file():
            main_py = install_path / "main.py"
        if not main_py.is_file():
            continue
        base_dir = Path(inst.get("adoptedBaseDir") or install_path)
        python = Path(inst.get("adoptedPythonPath") or _venv_python(base_dir))
        if not python.is_file():
            python = _venv_python(install_path)

        user_dir = base_dir / "user"
        # ComfyUI's default DB lives next to main.py, not in --user-directory;
        # pass it explicitly so the agent and Desktop share one database.
        args: list[str] = [
            "--base-directory", str(base_dir),
            "--user-directory", str(user_dir),
            "--database-url", f"sqlite:///{user_dir / 'comfyui.db'}",
        ]
        input_dir = inst.get("inputDir") or desktop_settings.get("inputDir")
        output_dir = inst.get("outputDir") or desktop_settings.get("outputDir")
        if input_dir:
            args += ["--input-directory", str(input_dir)]
        if output_dir:
            args += ["--output-directory", str(output_dir)]
        model_paths = data_dir / "instance-model-paths" / f"{inst.get('id', '')}.yaml"
        if model_paths.is_file():
            args += ["--extra-model-paths-config", str(model_paths)]

        # Desktop's own launch args, minus --port/--listen (derived from the URL).
        port = 8188
        tokens = str(inst.get("launchArgs") or "").split()
        i = 0
        while i < len(tokens):
            tok = tokens[i]
            has_value = i + 1 < len(tokens) and not tokens[i + 1].startswith("--")
            if tok == "--port" and has_value:
                try:
                    port = int(tokens[i + 1])
                except ValueError:
                    pass
                i += 2
                continue
            if tok == "--listen":
                i += 2 if has_value else 1
                continue
            args.append(tok)
            i += 1

        return {
            "name": inst.get("name") or install_path.name,
            "source": str(data_dir / "installations.json"),
            "python": str(python),
            "mainPy": str(main_py),
            "args": args,
            "url": f"http://127.0.0.1:{port}",
        }
    return None
