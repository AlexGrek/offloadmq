"""Convert between v2 TaskResult and server wire TaskResultReport."""
from __future__ import annotations

from datetime import timedelta

from offloadmq_agent.models import TaskResult, TaskStatus
from offloadmq_agent.wire import TaskId, TaskResultReport, TaskResultStatus


def report_to_task_result(report: TaskResultReport) -> TaskResult:
    st = report.status.status
    out = report.output or {}
    if st == "success":
        return TaskResult(
            task_id=report.task_id.id,
            status=TaskStatus.COMPLETED,
            output=out,
        )
    if st == "failure":
        msg = "Task failed"
        if isinstance(report.status.data, (list, tuple)) and report.status.data:
            msg = str(report.status.data[0])
        return TaskResult(
            task_id=report.task_id.id,
            status=TaskStatus.FAILED,
            output=out,
            error=msg,
        )
    return TaskResult(
        task_id=report.task_id.id,
        status=TaskStatus.CANCELLED,
        output=out,
        error=str(report.status.data) if report.status.data else "not executed",
    )


def task_result_to_wire(task_id: str, capability: str, result: TaskResult) -> dict:
    tid = TaskId(id=task_id, cap=capability)
    if result.status == TaskStatus.COMPLETED:
        report = TaskResultReport(
            id=tid,
            capability=capability,
            status=TaskResultStatus(status="success", data=timedelta(seconds=1.0)),
            output=result.output or {},
        )
    elif result.status == TaskStatus.CANCELLED:
        report = TaskResultReport(
            id=tid,
            capability=capability,
            status=TaskResultStatus(status="cancelled", data=result.error or "cancelled"),
            output=result.output or {},
        )
    else:
        reason = result.error or "task failed (the executor gave no reason)"
        output = dict(result.output or {})
        # The server only folds the failure message into an *empty* output, so a
        # failure that also carries data (e.g. partial LLM text) must name its
        # reason itself or clients see no error at all.
        if output and not output.get("error"):
            output["error"] = reason
        report = TaskResultReport(
            id=tid,
            capability=capability,
            status=TaskResultStatus(status="failure", data=(reason, timedelta(seconds=1.0))),
            output=output,
        )
    if capability.startswith("llm-runtime."):
        # Cover early pipeline failures as well as executor-generated reports.
        from offloadmq_agent.exec.runtime_results import fit_runtime_report

        report = fit_runtime_report(report)
    return report.to_wire()
