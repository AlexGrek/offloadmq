"""Full task pipeline: downloads, data prep, routed executor, captured result."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Callable

from offloadmq_agent.context import ExecContext, TaskCancelled
from offloadmq_agent.data.fs_utils import parse_file_reference, pick_directory
from offloadmq_agent.data.updn import process_data_download
from offloadmq_agent.exec.reporting import (
    TaskCancelled as ReportingCancelled,
    make_failure_report,
    report_cancelled,
    report_result,
    report_starting,
)
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.models import Task, TaskResult, TaskStatus
from offloadmq_agent.result_convert import report_to_task_result
from offloadmq_agent.transport_exec import CaptureTransport
from offloadmq_agent.transport_sync import SyncAgentTransport
from offloadmq_agent.wire import TaskId

logger = logging.getLogger(__name__)


def _task_data(task: Task) -> dict[str, Any]:
    if task.server_task:
        return dict(task.server_task.get("data") or {})
    return {"payload": task.payload}


def _download_buckets(
    transport: CaptureTransport,
    task_id: TaskId,
    capability: str,
    file_buckets: list[Any],
    data_path: Path,
) -> bool:
    for bucket_uid in file_buckets:
        try:
            resp = transport.get(
                "private", "agent", "bucket", str(bucket_uid), "stat", timeout=60
            )
            resp.raise_for_status()
            bucket_info = resp.json()
            for file_info in bucket_info.get("files", []):
                file_uid = file_info["file_uid"]
                original_name = file_info.get("original_name", file_uid)
                save_path = data_path / original_name
                if save_path.exists():
                    continue
                save_path.parent.mkdir(parents=True, exist_ok=True)
                dl = transport.get(
                    "private",
                    "agent",
                    "bucket",
                    str(bucket_uid),
                    "file",
                    file_uid,
                    timeout=300,
                )
                dl.raise_for_status()
                save_path.write_bytes(dl.content)
        except Exception as exc:
            logger.error("Bucket download failed: %s", exc)
            report = make_failure_report(task_id, capability, str(exc))
            report_result(transport, report)
            return False
    return True


def _download_fetch_files(
    transport: CaptureTransport,
    task_id: TaskId,
    capability: str,
    fetch_files: list[Any],
    data_path: Path,
) -> bool:
    for fileref in fetch_files:
        try:
            parsed = parse_file_reference(fileref)
            process_data_download(data_path, parsed)
        except Exception as exc:
            logger.error("fetchFiles failed: %s", exc)
            report = make_failure_report(task_id, capability, str(exc))
            report_result(transport, report)
            return False
    return True


def _run_sync_pipeline(
    task: Task,
    ctx: ExecContext,
    inner: SyncAgentTransport,
    progress_hook: Callable[[str, str], None] | None,
) -> TaskResult:
    data = _task_data(task)
    payload = data.get("payload") or task.payload or {}
    fetch_files = data.get("fetchFiles") or []
    file_buckets = data.get("file_bucket") or []
    output_bucket = data.get("output_bucket")
    job_timeout = int(data.get("timeoutSecs") or 600)
    data_preparation: dict[str, str] = dict(data.get("dataPreparation") or {})

    task_id = TaskId(id=task.id, cap=task.capability)
    capability = task.capability
    transport = CaptureTransport(inner, ctx, progress_hook=progress_hook)

    executor = route_executor(capability)
    if executor is None:
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.FAILED,
            error=f"No routed executor for '{capability}'",
        )

    data_path = pick_directory(task_id)

    try:
        report_starting(transport, task_id)
    except ReportingCancelled:
        report_cancelled(transport, task_id, capability)
        return TaskResult(
            task_id=task.id, status=TaskStatus.CANCELLED, error="Cancelled by user"
        )

    if file_buckets and not _download_buckets(
        transport, task_id, capability, file_buckets, data_path
    ):
        if transport.captured_report:
            return report_to_task_result(transport.captured_report)
        return TaskResult(
            task_id=task.id, status=TaskStatus.FAILED, error="Bucket download failed"
        )

    if fetch_files and not _download_fetch_files(
        transport, task_id, capability, fetch_files, data_path
    ):
        if transport.captured_report:
            return report_to_task_result(transport.captured_report)
        return TaskResult(
            task_id=task.id, status=TaskStatus.FAILED, error="File download failed"
        )

    if data_preparation:
        try:
            from offloadmq_agent.exec.data_preparation import apply_data_preparation

            apply_data_preparation(data_path, data_preparation)
        except Exception as exc:
            report = make_failure_report(task_id, capability, str(exc))
            report_result(transport, report)
            if transport.captured_report:
                return report_to_task_result(transport.captured_report)
            return TaskResult(task_id=task.id, status=TaskStatus.FAILED, error=str(exc))

    try:
        if capability.startswith("imggen.") or capability.startswith("txt2music."):
            executor(
                transport,
                task_id,
                capability,
                payload,
                data_path,
                output_bucket=output_bucket,
                job_timeout=job_timeout,
            )
        else:
            executor(
                transport,
                task_id,
                capability,
                payload,
                data_path,
                job_timeout=job_timeout,
            )
    except ReportingCancelled:
        report_cancelled(transport, task_id, capability)
        return TaskResult(
            task_id=task.id, status=TaskStatus.CANCELLED, error="Cancelled by user"
        )
    except Exception as exc:
        logger.exception("Executor failed")
        report = make_failure_report(task_id, capability, str(exc))
        report_result(transport, report)

    if transport.captured_report:
        return report_to_task_result(transport.captured_report)

    return TaskResult(
        task_id=task.id,
        status=TaskStatus.FAILED,
        error="Executor did not produce a result report",
    )


async def run_routed_task(
    task: Task,
    ctx: ExecContext,
    *,
    progress_hook: Callable[[str, str], None] | None = None,
) -> TaskResult:
    inner = ctx.agent_transport
    if inner is None:
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.FAILED,
            error="Agent transport not configured",
        )

    if ctx.cancelled:
        raise TaskCancelled()

    return await asyncio.to_thread(
        _run_sync_pipeline, task, ctx, inner, progress_hook
    )
