"""Keep runtime resolves deliverable over the agent WebSocket."""

from __future__ import annotations

from datetime import timedelta
import json
from typing import Any

from offloadmq_agent.wire import TaskResultReport, TaskResultStatus

# Axum accepts 16 MiB frames. Reserve ample space for the WS envelope and keep
# this check on the serialized report (escaping can multiply string lengths).
MAX_REPORT_BYTES = 8 * 1024 * 1024
_STREAMS = ("stdout", "text", "stderr", "sync_stdout", "sync_stderr")


def report_bytes(report: TaskResultReport) -> int:
    return len(json.dumps(report.to_wire(), ensure_ascii=True).encode("utf-8"))


def fit_runtime_report(report: TaskResultReport) -> TaskResultReport:
    """Oversized results fail explicitly; cancellation retains its status.

    Retain bounded diagnostic prefixes and artifact references. Never silently
    report a successful app whose returned data had to be dropped.
    """
    original_size = report_bytes(report)
    if original_size <= MAX_REPORT_BYTES:
        return report
    original = report.output or {}
    output: dict[str, Any] = {
        "text": "",
        "stdout": "",
        "stderr": "",
        "files": [],
        "result_truncated": True,
        "original_result_bytes": original_size,
        "original_status": report.status.status,
        "error": "Runtime result exceeds the 8 MiB serialized result limit",
    }
    for key in ("return_code", "sync_return_code"):
        if isinstance(original.get(key), int):
            output[key] = original[key]
    if "data" in original:
        output["data_omitted"] = True
    files = original.get("files", [])
    output["files"] = list(files) if isinstance(files, list) else []
    for key in _STREAMS:
        value = original.get(key)
        if isinstance(value, str):
            output[key] = value[: 128 * 1024]
    output["truncated_fields"] = [
        key for key in _STREAMS if original.get(key, "") != output.get(key, "")
    ]
    output["omitted_file_count"] = 0
    status = TaskResultStatus(status="failure", data=(output["error"], timedelta()))
    if report.status.status in ("cancelled", "notExecuted"):
        status = TaskResultStatus(
            status=report.status.status, data="Task cancelled by client"
        )
    bounded = report.model_copy(update={"output": output, "status": status})
    while report_bytes(bounded) > MAX_REPORT_BYTES:
        if output["files"]:
            count = len(output["files"])
            output["files"] = output["files"][: count // 2]
            output["omitted_file_count"] += count - len(output["files"])
        else:
            if not any(output.get(key) for key in _STREAMS):
                raise ValueError("Runtime report envelope exceeds the result limit")
            for key in _STREAMS:
                output[key] = output.get(key, "")[: len(output.get(key, "")) // 2]
            output["truncated_fields"] = [
                key for key in _STREAMS if original.get(key, "") != output.get(key, "")
            ]
    return bounded
