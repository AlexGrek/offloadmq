"""``shell.*`` executor — runs a command in a workspace with env, credentials and artifacts.

Lifecycle (contract: docs/shell-api.md):

1. ``prepare_shell_job`` (pipeline, before downloads): validate the payload,
   build the env map, resolve + create the workspace. Input files from
   ``file_bucket`` / ``fetchFiles`` are then downloaded into the workspace.
2. ``run_prepared``: resolve credentials, run the command with live
   (masked) log streaming, upload artifacts, report the result.
3. ``PreparedShellJob.cleanup`` (pipeline, always): remove the workspace when
   the cleanup policy says so and this task created it.
"""
from __future__ import annotations

import logging
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, Callable, Mapping

from offloadmq_agent.exec.reporting import (
    TaskCancelled,
    make_failure_report,
    make_success_report,
    report_cancelled,
    report_progress,
    report_result,
)
from offloadmq_agent.exec.windows_job import WindowsJob
from offloadmq_agent.settings_util import load_agent_settings
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.wire import TaskId

from .artifacts import WHEN_MODES, collect, upload_all, validate_patterns
from .credentials import CredentialError, resolve_credentials, validate_credentials
from .masking import Masker
from .shells import ShellSpec, build_argv, detect_shells
from .subst import SubstContext, build_env, env_set
from .workspace import Workspace, resolve_workspace

logger = logging.getLogger(__name__)

_WINDOWS = sys.platform == "win32"
TAIL_CHARS = 256 * 1024  # final stdout/stderr keep this much of the end
LIVE_LOG_CAP = 1024 * 1024  # total streamed to the task log
_FLUSH_SECS = 1.0
_FLUSH_LINES = 64
_READ_CHUNK = 64 * 1024
_TERM_GRACE_SECS = 5.0
_PIPE_GRACE_SECS = 1.0


class ShellJobError(ValueError):
    """Invalid payload or environment — reported as a task failure."""


@dataclass
class PreparedShellJob:
    capability: str
    shell: ShellSpec
    command: str
    strict: bool
    env: dict[str, str]
    workspace: Workspace
    credentials: list[dict[str, Any]]
    artifacts: list[str]
    artifacts_when: str
    output_bucket: str | None
    succeeded: bool = False

    def cleanup(self) -> bool:
        return self.workspace.remove(self.succeeded)


def normalize_payload(payload: Any) -> dict[str, Any]:
    """Old clients send the command as a bare string payload."""
    if isinstance(payload, str):
        return {"command": payload}
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return payload
    raise ShellJobError("payload must be an object or a command string")


def prepare_shell_job(
    task_id: TaskId,
    capability: str,
    payload: Any,
    output_bucket: str | None,
    *,
    settings: Mapping[str, Any] | None = None,
    shells: Mapping[str, ShellSpec] | None = None,
    base_env: Mapping[str, str] | None = None,
) -> PreparedShellJob:
    body = normalize_payload(payload)
    command = body.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ShellJobError("Payload missing 'command' field")

    suffix = capability.split("[", 1)[0].split(".", 1)[-1]
    available = detect_shells() if shells is None else shells
    spec = available.get(suffix)
    if spec is None:
        raise ShellJobError(f"shell '{suffix}' is not available on this agent")

    try:
        credentials = validate_credentials(body.get("credentials"))
        patterns = validate_patterns(body.get("artifacts"))
        when = body.get("artifacts_when") or "on_success"
        if when not in WHEN_MODES:
            raise ShellJobError(f"'artifacts_when' must be one of {', '.join(WHEN_MODES)}")
        if patterns and not output_bucket:
            raise ShellJobError("'artifacts' needs an output_bucket on the task")
        ctx = SubstContext(task_id=task_id.id)
        env = build_env(body.get("env"), body.get("inherit_env", True) is not False, ctx, base_env)
        workspace = resolve_workspace(
            body.get("workspace"),
            body.get("cleanup"),
            ctx,
            env,
            load_agent_settings() if settings is None else settings,
            task_id,
        )
    except ShellJobError:
        raise
    except ValueError as exc:
        raise ShellJobError(str(exc)) from None

    return PreparedShellJob(
        capability=capability,
        shell=spec,
        command=command,
        strict=body.get("strict") is True,
        env=env,
        workspace=workspace,
        credentials=credentials,
        artifacts=patterns,
        artifacts_when=when,
        output_bucket=output_bucket,
    )


# ---------------------------------------------------------------------------
# Output plumbing
# ---------------------------------------------------------------------------


class _Tail:
    """Keeps the last ``cap`` characters of a stream."""

    def __init__(self, cap: int) -> None:
        self._cap = cap
        self._chunks: deque[str] = deque()
        self._size = 0
        self.truncated = False

    def add(self, text: str) -> None:
        self._chunks.append(text)
        self._size += len(text)
        while self._size > self._cap and len(self._chunks) > 1:
            self._size -= len(self._chunks.popleft())
            self.truncated = True

    def text(self) -> str:
        joined = "".join(self._chunks)
        if len(joined) > self._cap:
            self.truncated = True
            return joined[-self._cap:]
        return joined


class _LiveLog:
    """Batches masked lines into progress updates (≈1 s / 64 lines), capped in total size."""

    def __init__(self, transport: AgentTransport, task_id: TaskId) -> None:
        self._transport = transport
        self._task_id = task_id
        self._pending: list[str] = []
        self._sent = 0
        self._last = time.monotonic()
        self.truncated = False

    def add(self, text: str) -> None:
        if self.truncated:
            return
        if self._sent + len(text) > LIVE_LOG_CAP:
            self._pending.append(
                "\n[live log truncated at 1 MiB — the result keeps the stdout/stderr tails]\n"
            )
            self.truncated = True
            return
        self._pending.append(text)
        self._sent += len(text)

    def flush(self, *, force: bool = False, stage: str = "running") -> None:
        """May raise ``TaskCancelled`` (the server/agent cancelled the task)."""
        if not self._pending:
            return
        now = time.monotonic()
        if not force and len(self._pending) < _FLUSH_LINES and now - self._last < _FLUSH_SECS:
            return
        text = "".join(self._pending)
        self._pending.clear()
        self._last = now
        report_progress(self._transport, log=text, stage=stage, task_id=self._task_id)


@dataclass
class _Outcome:
    exit_code: int | None
    stdout: _Tail
    stderr: _Tail
    timed_out: bool = False
    cancelled: bool = False


def _reader(stream: IO[bytes], tag: str, out: queue.Queue[tuple[str, bytes | None]]) -> None:
    try:
        for chunk in iter(lambda: stream.readline(_READ_CHUNK), b""):
            out.put((tag, chunk))
    except (OSError, ValueError):
        pass
    finally:
        out.put((tag, None))


def _spawn(argv: list[str], env: dict[str, str], cwd: Path) -> tuple[subprocess.Popen[bytes], WindowsJob | None]:
    job = WindowsJob() if _WINDOWS else None
    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=job is None,
            creationflags=0x00000004 if job is not None else 0,  # CREATE_SUSPENDED
        )
    except BaseException:
        if job is not None:
            job.close()
        raise
    if job is not None:
        try:
            job.assign_and_resume(proc.pid)
        except BaseException:
            proc.kill()
            proc.wait()
            job.close()
            raise
    return proc, job


def _kill_tree(proc: subprocess.Popen[bytes], job: WindowsJob | None, *, graceful: bool) -> None:
    """Kill the job's whole process tree (background children included)."""
    if job is not None:
        try:
            job.terminate()
        except (OSError, TimeoutError):
            logger.warning("shell: Windows job termination failed", exc_info=True)
    else:
        if graceful and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                proc.wait(timeout=_TERM_GRACE_SECS)
            except (ProcessLookupError, PermissionError, subprocess.TimeoutExpired):
                pass
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    if proc.poll() is None:
        proc.kill()
    proc.wait()


def _run_process(
    argv: list[str],
    env: dict[str, str],
    cwd: Path,
    timeout: int,
    live: _LiveLog,
    masker: Masker,
    is_cancelled: Callable[[], bool],
) -> _Outcome:
    outcome = _Outcome(None, _Tail(TAIL_CHARS), _Tail(TAIL_CHARS))
    lines: queue.Queue[tuple[str, bytes | None]] = queue.Queue()
    proc, job = _spawn(argv, env, cwd)
    assert proc.stdout is not None and proc.stderr is not None
    readers = [
        threading.Thread(target=_reader, args=(proc.stdout, "out", lines), daemon=True),
        threading.Thread(target=_reader, args=(proc.stderr, "err", lines), daemon=True),
    ]
    for t in readers:
        t.start()
    open_streams = 2

    def pump(wait: float) -> None:
        nonlocal open_streams
        try:
            item: tuple[str, bytes | None] | None = lines.get(timeout=wait)
        except queue.Empty:
            return
        while item is not None:
            tag, chunk = item
            if chunk is None:
                open_streams -= 1
            else:
                text = masker(chunk.decode("utf-8", errors="replace"))
                (outcome.stdout if tag == "out" else outcome.stderr).add(text)
                line = text if text.endswith("\n") else text + "\n"
                live.add(line if tag == "out" else "[stderr] " + line)
            try:
                item = lines.get_nowait()
            except queue.Empty:
                item = None

    deadline = time.monotonic() + timeout
    try:
        try:
            while proc.poll() is None:
                pump(0.2)
                if is_cancelled():
                    raise TaskCancelled("cancelled")
                if time.monotonic() > deadline:
                    outcome.timed_out = True
                    _kill_tree(proc, job, graceful=True)
                    break
                live.flush()
        except TaskCancelled:
            outcome.cancelled = True
            _kill_tree(proc, job, graceful=True)

        # The root exited: let the pipes drain briefly, then reap background
        # children still holding them open.
        grace_end = time.monotonic() + _PIPE_GRACE_SECS
        while open_streams and time.monotonic() < grace_end:
            pump(0.05)
        _kill_tree(proc, job, graceful=False)
        for t in readers:
            t.join(timeout=5)
        while open_streams:
            before = open_streams
            pump(0.1)
            if before == open_streams and not any(t.is_alive() for t in readers):
                break
    finally:
        if job is not None:
            job.close()
        for stream in (proc.stdout, proc.stderr):
            stream.close()

    outcome.exit_code = proc.returncode
    return outcome


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


def run_prepared(
    transport: AgentTransport, task_id: TaskId, job: PreparedShellJob, job_timeout: int,
) -> bool:
    capability = job.capability
    started = time.monotonic()
    masker = Masker()
    is_cancelled: Callable[[], bool] = getattr(transport, "is_cancelled", lambda: False)
    live = _LiveLog(transport, task_id)
    output: dict[str, Any] = {
        "shell": job.shell.kind,
        "shell_path": job.shell.path,
        "workspace": str(job.workspace.path),
    }

    def fail(message: str, extra: dict[str, Any] | None = None) -> bool:
        message = masker(message)
        out = {**output, **(extra or {}), "error": message}
        try:
            live.flush(force=True, stage="failed")
        except TaskCancelled:
            pass
        report = make_failure_report(
            task_id, capability, message, time.monotonic() - started, extra_output=out,
        )
        return report_result(transport, report)

    scratch = Path(tempfile.mkdtemp(prefix="omq-shell-"))  # scripts + secret files
    try:
        try:
            creds = resolve_credentials(
                job.credentials,
                shell=job.shell,
                env=job.env,
                cwd=job.workspace.path,
                scratch_dir=scratch,
                masker=masker,
            )
        except CredentialError as exc:
            return fail(str(exc))

        env = dict(job.env)
        for name, value in creds.env.items():
            env_set(env, name, value)
        for name, value in (
            ("OMQ_TASK_ID", task_id.id),
            ("OMQ_CAPABILITY", capability),
            ("OMQ_SHELL", job.shell.kind),
            ("OMQ_WORKSPACE", str(job.workspace.path)),
            ("OMQ_ARTIFACTS_DIR", str(job.workspace.path)),
        ):
            env_set(env, name, value)

        argv = build_argv(job.shell, job.command, scratch, strict=job.strict)
        first_line = job.command.strip().splitlines()[0][:200]
        live.add(masker(f"$ {first_line}\n") + f"[{job.shell.kind} in {job.workspace.path}]\n")

        try:
            result = _run_process(
                argv, env, job.workspace.path, job_timeout, live, masker, is_cancelled,
            )
        except OSError as exc:
            return fail(f"cannot start {job.shell.kind}: {exc}")

        exit_code = result.exit_code if result.exit_code is not None else -1
        output.update({
            "exit_code": exit_code,
            "stdout": result.stdout.text(),
            "stderr": result.stderr.text(),
            "stdout_truncated": result.stdout.truncated,
            "stderr_truncated": result.stderr.truncated,
            "artifacts": [],
            "artifacts_missing": [],
        })

        if result.cancelled:
            output["duration_ms"] = int((time.monotonic() - started) * 1000)
            report_cancelled(transport, task_id, capability, output=output)
            return True
        if result.timed_out:
            output["duration_ms"] = int((time.monotonic() - started) * 1000)
            return fail(f"Timed out after {job_timeout}s", {"timed_out": True})

        if job.artifacts and job.output_bucket and (exit_code == 0 or job.artifacts_when == "always"):
            try:
                files, missing = collect(job.workspace.path, job.artifacts)
                output["artifacts"] = upload_all(
                    job.workspace.path,
                    files,
                    job.output_bucket,
                    lambda bucket, name, data, ctype: transport.upload_file(bucket, name, data, ctype),
                    lambda rel, size: live.add(f"[artifacts] uploaded {rel} ({size} bytes)\n"),
                )
                output["artifacts_missing"] = missing
                if missing:
                    live.add(f"[artifacts] no match for: {', '.join(missing)}\n")
            except Exception as exc:  # glob/IO/upload — the job ran, the hand-off failed
                output["duration_ms"] = int((time.monotonic() - started) * 1000)
                return fail(f"artifact upload failed: {exc}")
        elif job.artifacts:
            output["artifacts_skipped"] = True

        output["duration_ms"] = int((time.monotonic() - started) * 1000)
        try:
            live.flush(force=True, stage="done" if exit_code == 0 else "failed")
        except TaskCancelled:
            report_cancelled(transport, task_id, capability, output=output)
            return True

        job.succeeded = exit_code == 0
        if exit_code == 0:
            report = make_success_report(task_id, capability, output, time.monotonic() - started)
            return report_result(transport, report)
        stderr_tail = output["stderr"].strip()[-2000:]
        return fail(stderr_tail or f"Command failed with exit code {exit_code}")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def execute_shell_job(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: Any,
    data: Path,
    job_timeout: int = 600,
    output_bucket: str | None = None,
    prepared: PreparedShellJob | None = None,
) -> bool:
    """Routed entry point. The pipeline normally passes ``prepared`` (and owns cleanup)."""
    if prepared is not None:
        return run_prepared(transport, task_id, prepared, job_timeout)
    try:
        job = prepare_shell_job(task_id, capability, payload, output_bucket)
    except ShellJobError as exc:
        return report_result(transport, make_failure_report(task_id, capability, str(exc)))
    try:
        return run_prepared(transport, task_id, job, job_timeout)
    finally:
        job.cleanup()
