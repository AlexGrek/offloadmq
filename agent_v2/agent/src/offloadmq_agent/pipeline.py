"""Full task pipeline: downloads, data prep, routed executor, captured result."""

from __future__ import annotations

import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Any, Callable

from offloadmq_agent.context import ExecContext, TaskCancelled
from offloadmq_agent.data.fs_utils import (
    parse_file_reference,
    pick_directory,
    resolve_bucket_file_path,
)
from offloadmq_agent.data.updn import process_data_download
from offloadmq_agent.exec.reporting import (
    TaskCancelled as ReportingCancelled,
    make_failure_report,
    report_cancelled,
    report_result,
    report_starting,
)
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.models import Task, TaskResult, TaskStatus, describe_exception
from offloadmq_agent.result_convert import report_to_task_result
from offloadmq_agent.transport_exec import CaptureTransport
from offloadmq_agent.transport_sync import SyncAgentTransport
from offloadmq_agent.wire import TaskId

logger = logging.getLogger(__name__)


# Executors that upload their results to a server bucket and therefore take an
# extra output_bucket argument. "image_resize" is bare — it has no sub-name.
_OUTPUT_BUCKET_PREFIXES = (
    "imggen.",
    "img-utils.",
    "txt2music.",
    "llm-runtime.",
    "world.",
    "onnx.bgremove.",
    "shell.",
)
_OUTPUT_BUCKET_CAPS = ("image_resize",)


def _takes_output_bucket(capability: str) -> bool:
    return capability in _OUTPUT_BUCKET_CAPS or capability.startswith(
        _OUTPUT_BUCKET_PREFIXES
    )


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
    overwrite: bool = False,
) -> bool:
    """Download every bucket file into ``data_path``.

    Existing files are kept unless ``overwrite`` — shell workspaces can persist
    between tasks, where a stale copy would silently shadow the new input.
    """
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
                save_path = resolve_bucket_file_path(data_path, original_name)
                if save_path.exists() and not overwrite:
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
            report = make_failure_report(task_id, capability, describe_exception(exc))
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
            report = make_failure_report(task_id, capability, describe_exception(exc))
            report_result(transport, report)
            return False
    return True


def _run_sync_pipeline(
    task: Task,
    ctx: ExecContext,
    inner: SyncAgentTransport,
    progress_hook: Callable[[str, str], None] | None,
    data_path_override: Path | None = None,
) -> TaskResult:
    if task.capability.startswith("llm-runtime."):
        from offloadmq_agent.exec.llm_runtime import require_enabled

        try:
            require_enabled(
                task.capability, _task_data(task).get("payload") or task.payload or {}
            )
        except ValueError as exc:
            return TaskResult(task_id=task.id, status=TaskStatus.FAILED, error=describe_exception(exc))

    data = _task_data(task)
    payload = data.get("payload") or task.payload or {}
    fetch_files = data.get("fetchFiles") or []
    file_buckets = data.get("file_bucket") or []
    output_bucket = data.get("output_bucket")
    job_timeout = task.runtime_limit_secs()
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

    try:
        report_starting(transport, task_id)
    except ReportingCancelled:
        report_cancelled(transport, task_id, capability)
        return TaskResult(
            task_id=task.id, status=TaskStatus.CANCELLED, error="Cancelled by user"
        )

    # shell.* resolves its workspace first so input files are staged into it;
    # this function then owns the workspace cleanup.
    prepared: Any = None
    if capability.startswith("shell."):
        from offloadmq_agent.exec.shell.executor import ShellJobError, prepare_shell_job

        try:
            prepared = prepare_shell_job(task_id, capability, payload, output_bucket)
        except ShellJobError as exc:
            report_result(transport, make_failure_report(task_id, capability, str(exc)))
            if transport.captured_report:
                return report_to_task_result(transport.captured_report)
            return TaskResult(task_id=task.id, status=TaskStatus.FAILED, error=str(exc))
        data_path = prepared.workspace.path
    else:
        data_path = data_path_override or pick_directory(task_id)

    try:
        return _run_staged(
            task, transport, executor, task_id, capability, payload, data_path,
            fetch_files, file_buckets, output_bucket, data_preparation, job_timeout,
            prepared,
        )
    finally:
        if prepared is not None:
            prepared.cleanup()


def _run_staged(
    task: Task,
    transport: CaptureTransport,
    executor: Callable[..., bool],
    task_id: TaskId,
    capability: str,
    payload: Any,
    data_path: Path,
    fetch_files: list[Any],
    file_buckets: list[Any],
    output_bucket: str | None,
    data_preparation: dict[str, str],
    job_timeout: int,
    prepared: Any,
) -> TaskResult:

    if file_buckets and not _download_buckets(
        transport, task_id, capability, file_buckets, data_path,
        overwrite=prepared is not None,
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
            report = make_failure_report(task_id, capability, describe_exception(exc))
            report_result(transport, report)
            if transport.captured_report:
                return report_to_task_result(transport.captured_report)
            return TaskResult(task_id=task.id, status=TaskStatus.FAILED, error=describe_exception(exc))

    try:
        if prepared is not None:
            executor(
                transport,
                task_id,
                capability,
                payload,
                data_path,
                output_bucket=output_bucket,
                job_timeout=job_timeout,
                prepared=prepared,
            )
        elif _takes_output_bucket(capability):
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
        report = make_failure_report(task_id, capability, describe_exception(exc))
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

    if task.capability.startswith("llm-runtime."):
        with tempfile.TemporaryDirectory(prefix="offload-llm-runtime-") as work:
            return await asyncio.to_thread(
                _run_sync_pipeline, task, ctx, inner, progress_hook, Path(work)
            )

    return await asyncio.to_thread(_run_sync_pipeline, task, ctx, inner, progress_hook)
