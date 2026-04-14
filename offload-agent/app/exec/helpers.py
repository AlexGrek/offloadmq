import logging
import random
import time
from datetime import timedelta
from typing import Any, Callable, Optional

import requests
import typer

from ..httphelpers import HttpClient
from ..models import *
from ..transport import AgentTransport

logger = logging.getLogger("agent")


class TaskCancelled(Exception):
    """Raised when the server returns 499, indicating the client cancelled the task.

    Executors should catch this to stop work gracefully:
    kill subprocesses, collect partial output, and call ``report_cancelled``.
    """
    pass

# ---------------------------------------------------------------------------
# Log buffer — accumulates unsent progress logs per task
# ---------------------------------------------------------------------------
_pending_logs: dict[str, list[str]] = {}
_pending_stage: dict[str, Optional[str]] = {}
ReportClient = AgentTransport | HttpClient


def _buffer_log(task_id: TaskId, log: Optional[str], stage: Optional[str]) -> None:
    """Append log text and stage to the per-task buffer."""
    key = task_id.id
    if log:
        _pending_logs.setdefault(key, []).append(log)
    if stage is not None:
        _pending_stage[key] = stage


def _drain_logs(task_id: TaskId) -> tuple[Optional[str], Optional[str]]:
    """Pop all buffered logs for a task and return (merged_log, last_stage)."""
    key = task_id.id
    logs = _pending_logs.pop(key, [])
    stage = _pending_stage.pop(key, None)
    combined = "".join(logs) if logs else None
    return combined, stage


# ---------------------------------------------------------------------------
# Retry infrastructure
# ---------------------------------------------------------------------------

def _is_retryable(exc: Exception) -> bool:
    """Return True if the error is transient and worth retrying."""
    if isinstance(exc, requests.HTTPError):
        resp = exc.response
        if resp is not None:
            code = resp.status_code
            # 408 Request Timeout and 429 Too Many Requests are retryable
            if code in (408, 429):
                return True
            # Other 4xx are permanent (bad payload, auth, not found, etc.)
            if 400 <= code < 500:
                return False
            # 5xx are transient server errors
            if code >= 500:
                return True
    # Connection errors, timeouts, and anything else are retryable
    if isinstance(exc, (requests.ConnectionError, requests.Timeout)):
        return True
    # Other RequestException subclasses — assume transient
    if isinstance(exc, requests.RequestException):
        return True
    return False


def _retry_post(
    send_fn: Callable[[], requests.Response],
    max_elapsed_sec: float,
    base_delay: float,
    max_delay: float,
) -> requests.Response:
    """POST with exponential backoff. Raises on permanent or exhausted failure."""
    start = time.monotonic()
    delay = base_delay
    last_exc: Optional[Exception] = None

    while True:
        try:
            resp = send_fn()
            if resp.status_code == 499:
                raise TaskCancelled("Server returned 499 — task cancelled by client")
            resp.raise_for_status()
            return resp
        except TaskCancelled:
            raise
        except Exception as exc:
            last_exc = exc
            if not _is_retryable(exc):
                raise

            elapsed = time.monotonic() - start
            if elapsed >= max_elapsed_sec:
                logger.warning(
                    f"Retry budget exhausted ({max_elapsed_sec:.0f}s). Last error: {exc}"
                )
                raise

            jittered = delay * random.uniform(0.8, 1.2)
            remaining = max_elapsed_sec - elapsed
            sleep_time = min(jittered, remaining)
            if sleep_time <= 0:
                raise

            logger.info(f"Transient error, retrying in {sleep_time:.1f}s: {exc}")
            time.sleep(sleep_time)
            delay = min(delay * 2, max_delay)


def _progress_wire_status(stage: Optional[str], has_log: bool) -> Optional[str]:
    """JSON TaskStatus strings for the progress API (serde camelCase on the server)."""
    if stage == "cancelled":
        return None
    if stage == "starting":
        return "starting"
    if has_log or stage is not None:
        return "running"
    return None


def _post_progress(
    transport: ReportClient, task_id: TaskId, report: TaskProgressReport, timeout: int
) -> requests.Response:
    if hasattr(transport, "post_task_progress"):
        return transport.post_task_progress(task_id, report, timeout=timeout)
    q = task_id.quoted()
    return transport.post(
        "private", "agent", "task", "progress", q.cap, q.id,
        json_body=report.to_wire(),
        timeout=timeout,
    )


def _post_result(
    transport: ReportClient, report: TaskResultReport, timeout: int
) -> requests.Response:
    if hasattr(transport, "post_task_result"):
        return transport.post_task_result(report, timeout=timeout)
    q = report.task_id.quoted()
    return transport.post(
        "private", "agent", "task", "resolve", q.cap, q.id,
        json_body=report.to_wire(),
        timeout=timeout,
    )


def _flush_logs(transport: ReportClient, task_id: TaskId) -> bool:
    """Send all buffered logs with fast retry. Called before report_result."""
    combined, stage = _drain_logs(task_id)
    if combined is None and stage is None:
        return True

    wire_status = _progress_wire_status(stage, combined is not None)
    report = TaskProgressReport(
        id=task_id, stage=stage, log_update=combined, status=wire_status
    )
    try:
        _retry_post(
            send_fn=lambda: _post_progress(transport, task_id, report, timeout=30),
            max_elapsed_sec=30.0,
            base_delay=1.0,
            max_delay=16.0,
        )
        return True
    except TaskCancelled:
        # 499 means the server received the logs — task is cancelled but data accepted
        return True
    except Exception as e:
        logger.warning(f"Failed to flush buffered logs for task {task_id.id}: {e}")
        return False


# ---------------------------------------------------------------------------
# Public API — signatures unchanged
# ---------------------------------------------------------------------------

def report_result(transport: ReportClient, report: TaskResultReport) -> bool:
    """Send final task result to the server with retry (up to 5 minutes)."""
    # Flush any buffered logs first (best-effort, doesn't block result)
    _flush_logs(transport, report.task_id)

    q = report.task_id.quoted()
    logger.info(f"Sending resolve report: {report.to_wire()}")
    try:
        typer.echo(f"Reporting result for task id={q.id} cap={q.cap}")
        resp = _retry_post(
            send_fn=lambda: _post_result(transport, report, timeout=60),
            max_elapsed_sec=300.0,
            base_delay=2.0,
            max_delay=60.0,
        )
        if resp.content:
            try:
                typer.echo(resp.content.decode("utf-8", errors="ignore"))
            except Exception:
                pass
        typer.echo(f"Task result reported. Status Code: {resp.status_code}")
        return True
    except TaskCancelled:
        # 499 on resolve means the server saved output but task was already cancelled.
        # This is expected — the agent's job is done.
        logger.info(f"Task {q.id} was cancelled by client (499 on resolve)")
        return True
    except requests.RequestException as e:
        typer.echo(f"Failed to report task result after retries: {e}")
        return False


def report_starting(transport: ReportClient, task_id: TaskId) -> bool:
    """Signal to the server that the agent has started working on the task.

    Raises ``TaskCancelled`` if the server returns 499.
    """
    report = TaskProgressReport(
        id=task_id, stage="starting", log_update=None, status="starting"
    )
    try:
        resp = _post_progress(transport, task_id, report, timeout=10)
        if resp.status_code == 499:
            raise TaskCancelled("Server returned 499 — task cancelled by client")
        resp.raise_for_status()
        return True
    except TaskCancelled:
        raise
    except requests.RequestException:
        _buffer_log(task_id, None, "starting")
        return False


def report_progress(transport: ReportClient, log: Optional[str], stage: Optional[str], task_id: TaskId) -> bool:
    """Send progress/logs to server. On failure, buffers for next attempt.

    Raises ``TaskCancelled`` if the server returns 499.
    """
    # Merge any previously buffered logs into this call
    buffered_log, buffered_stage = _drain_logs(task_id)
    merged_log: Optional[str] = None
    if buffered_log or log:
        merged_log = (buffered_log or "") + (log or "")
    effective_stage = stage if stage is not None else buffered_stage

    wire_status = _progress_wire_status(effective_stage, merged_log is not None)
    report = TaskProgressReport(
        id=task_id,
        stage=effective_stage,
        log_update=merged_log,
        status=wire_status,
    )
    try:
        resp = _post_progress(transport, task_id, report, timeout=10)
        if resp.status_code == 499:
            raise TaskCancelled("Server returned 499 — task cancelled by client")
        resp.raise_for_status()
        return True
    except TaskCancelled:
        raise
    except requests.RequestException:
        # Failed — re-buffer everything for next attempt
        _buffer_log(task_id, merged_log, effective_stage)
        return False


def make_success_report(
    task_id: TaskId, capability: str, output: dict[str, Any], duration_sec: float = 12.5
) -> TaskResultReport:
    return TaskResultReport(
        id=task_id,
        status=TaskResultStatus(status="success", data=timedelta(seconds=duration_sec)),
        output=output,
        capability=capability,
    )


def make_failure_report(
    task_id: TaskId,
    capability: str,
    message: str,
    duration_sec: float = 5.0,
    extra_output: Optional[dict[str, Any]] = None,
) -> TaskResultReport:
    return TaskResultReport(
        id=task_id,
        status=TaskResultStatus(
            status="failure", data=(message, timedelta(seconds=duration_sec))
        ),
        output=extra_output or {"error": message},
        capability=capability,
    )


def report_cancelled(
    transport: ReportClient,
    task_id: TaskId,
    capability: str,
    output: Optional[dict[str, Any]] = None,
    remaining_log: Optional[str] = None,
) -> None:
    """Gracefully close a cancelled task: flush remaining logs and send resolve.

    Called by executors after catching ``TaskCancelled``. The server will
    return 499 on both progress and resolve calls — this is expected and
    handled internally.
    """
    if remaining_log:
        try:
            report_progress(transport, log=remaining_log, stage="cancelled", task_id=task_id)
        except TaskCancelled:
            pass  # Expected — server already knows it's cancelled
    report = make_failure_report(
        task_id, capability, "Task cancelled by client", extra_output=output,
    )
    report_result(transport, report)
