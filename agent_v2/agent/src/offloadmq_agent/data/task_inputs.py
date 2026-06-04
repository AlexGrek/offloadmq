"""Stage a task's input bucket files for native async executors.

Routed executors get their input files downloaded and pre-processed by
``pipeline.run_routed_task``. Native async executors (``llm`` etc.) bypass that
pipeline, so this helper performs the same two steps on demand: download every
file from the task's ``file_bucket`` list into a per-task data directory and
apply the ``dataPreparation`` rules (rescale / transcode) to them.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Protocol

from offloadmq_agent.data.fs_utils import pick_directory
from offloadmq_agent.models import Task
from offloadmq_agent.wire import TaskId

logger = logging.getLogger(__name__)


class _BucketGetter(Protocol):
    """Minimal transport surface needed to stat/download bucket files."""

    def get(self, *segments: str, timeout: int = ...) -> Any: ...


def _download_bucket_files(
    transport: _BucketGetter, file_buckets: list[Any], data_path: Path
) -> None:
    """Download every file from each bucket into ``data_path`` under its original name."""
    for bucket_uid in file_buckets:
        resp = transport.get(
            "private", "agent", "bucket", str(bucket_uid), "stat", timeout=60
        )
        resp.raise_for_status()
        for file_info in resp.json().get("files", []):
            file_uid = file_info["file_uid"]
            original_name = file_info.get("original_name", file_uid)
            save_path = data_path / original_name
            if save_path.exists():
                continue
            save_path.parent.mkdir(parents=True, exist_ok=True)
            dl = transport.get(
                "private", "agent", "bucket", str(bucket_uid), "file", file_uid,
                timeout=300,
            )
            dl.raise_for_status()
            save_path.write_bytes(dl.content)
            logger.info("Downloaded %s (%d bytes)", original_name, len(dl.content))


def stage_task_inputs(task: Task, transport: _BucketGetter) -> Path | None:
    """Download the task's bucket files and apply ``dataPreparation``.

    Returns the directory holding the staged files, or ``None`` when the task
    declared no input buckets. Raises on download / preparation failure so the
    caller can fail the task explicitly.
    """
    data = dict(task.server_task.get("data") or {})
    file_buckets = data.get("file_bucket") or []
    if not file_buckets:
        return None

    data_path = pick_directory(TaskId(id=task.id, cap=task.capability))
    _download_bucket_files(transport, file_buckets, data_path)

    rules: dict[str, str] = dict(data.get("dataPreparation") or {})
    if rules:
        # Lazy import: data/ is imported by exec/, so importing exec at module
        # load time would create a cycle.
        from offloadmq_agent.exec.data_preparation import apply_data_preparation

        apply_data_preparation(data_path, rules)

    return data_path
