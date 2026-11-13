"""Runtime reporting and process ownership at the pipeline/transport boundaries."""

import asyncio
import ctypes as ct
import json
import os
from pathlib import Path
import sys
import threading
import time
from unittest.mock import Mock

import psutil
import pytest
from aiohttp import web

from offloadmq_agent.client import OffloadMQClient
from offloadmq_agent.context import ExecContext
from offloadmq_agent.exec import llm_runtime as rt
from offloadmq_agent.exec import windows_job as win
from offloadmq_agent.exec.runtime_results import (
    fit_runtime_report,
    MAX_REPORT_BYTES,
    report_bytes,
)
from offloadmq_agent.exec.reporting import make_success_report, make_cancelled_report
from offloadmq_agent.models import Task, TaskResult, TaskStatus
from offloadmq_agent.pipeline import run_routed_task
from offloadmq_agent.result_convert import report_to_task_result, task_result_to_wire
from offloadmq_agent.wire import TaskId

CAP = "llm-runtime.test:latest"


@pytest.mark.parametrize("cancelled", [False, True])
def test_complete_serialized_result_budget(cancelled):
    # Escaped astral Unicode consumes 12 JSON bytes per Python character.
    text = "\U0001f600" * (rt.MAX_CAPTURE // 4)
    output = dict(
        stdout=text,
        text=text,
        stderr=text,
        sync_stdout=text,
        sync_stderr=text,
        data={"huge": text},
        files=[{"file_uid": "1"}],
    )
    tid = TaskId(id="1", cap=CAP)
    report = (
        make_cancelled_report(tid, CAP, output)
        if cancelled
        else make_success_report(tid, CAP, output)
    )
    bounded = fit_runtime_report(report)
    assert report_bytes(bounded) <= MAX_REPORT_BYTES
    assert bounded.output["result_truncated"]
    assert bounded.output["data_omitted"]
    assert bounded.output["text"] == bounded.output["stdout"]
    assert bounded.output["files"] == output["files"]
    assert bounded.status.status == ("cancelled" if cancelled else "failure")
    # The original report remains intact for callers retaining it.
    assert report.output["stdout"] == text


def test_size_guard_covers_large_failure_messages():
    result = TaskResult(
        task_id="1",
        status=TaskStatus.FAILED,
        error="x" * (16 * 1024 * 1024),
        output={"stdout": "partial"},
    )
    wire = task_result_to_wire("1", CAP, result)
    assert len(json.dumps(wire).encode()) < MAX_REPORT_BYTES
    assert wire["output"]["stdout"] == "partial"


def test_small_results_unchanged():
    report = make_success_report(
        TaskId(id="1", cap=CAP), CAP, {"text": "hello", "data": [42]}
    )
    assert fit_runtime_report(report) is report


def test_oversized_result_delivered_and_acknowledged_over_websocket():
    async def scenario():
        received = []

        async def handler(request):
            ws = web.WebSocketResponse(max_msg_size=16 * 1024 * 1024)
            await ws.prepare(request)
            message = await ws.receive(timeout=10)
            received.append(json.loads(message.data))
            await ws.send_json(
                {"type": "response", "status": 200, "req_id": received[0]["req_id"]}
            )
            await ws.close()
            return ws

        import socket

        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        app = web.Application()
        app.router.add_get("/private/agent/ws", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        client = OffloadMQClient(f"http://127.0.0.1:{port}", "test")
        try:
            await web.SockSite(runner, listener).start()
            await client.open_ws()

            async def receive_ack():
                async for frame in client.ws_messages():
                    if client.handle_ack(frame):
                        return

            text = "x" * rt.MAX_CAPTURE
            result = TaskResult(
                task_id="1",
                status=TaskStatus.COMPLETED,
                output={"stdout": text, "text": text, "stderr": ""},
            )
            await asyncio.wait_for(
                asyncio.gather(client.resolve(CAP, result), receive_ack()), 10
            )
            wire = received[0]["params"]
            assert "failure" in wire["status"]
            assert wire["output"]["result_truncated"]
            assert wire["output"]["stdout"] == wire["output"]["text"]
        finally:
            await client.close()
            await runner.cleanup()
            listener.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("phase", ["dependencies", "running", "waiting"])
def test_pipeline_preserves_cancel_status_and_partial_streams(
    monkeypatch, tmp_path, phase
):
    event = threading.Event()
    monkeypatch.setattr(
        rt,
        "load_agent_settings",
        lambda: {"llm_runtime_enabled": True, "sensitive_allowed_caps": [CAP]},
    )
    monkeypatch.setattr(rt, "CACHE_ROOT", tmp_path / "cache")
    monkeypatch.setattr(rt.shutil, "which", lambda name: "uv")
    calls = []

    def run(command, cwd, env, stdin, tick, output, prefix=""):
        calls.append(prefix)
        if phase == "running" and prefix:
            return 0
        output[prefix + "stdout"] = "partial stdout"
        output[prefix + "stderr"] = "partial stderr"
        if not prefix:
            output["text"] = output["stdout"]
        event.set()
        tick()  # Real CaptureTransport observes the context cancellation event.

    monkeypatch.setattr(rt, "run_process", run)

    def progress(stage, message):
        if phase == "waiting" and stage == "dependencies":
            event.set()

    ctx = ExecContext(lambda entry: None, cancel_event=event, agent_transport=object())
    task = Task(
        id="1",
        capability=CAP,
        payload={"entrypoint": "app.py", "files": {"app.py": "pass"}},
    )
    if phase == "waiting":
        rt._CACHE_LOCK.acquire()
    try:
        result = asyncio.run(run_routed_task(task, ctx, progress_hook=progress))
    finally:
        if phase == "waiting":
            rt._CACHE_LOCK.release()
    assert result.status == TaskStatus.CANCELLED
    wire = task_result_to_wire("1", CAP, result)
    assert wire["status"] == {"canceled": "Task cancelled by client"}
    assert (
        report_to_task_result(
            make_cancelled_report(TaskId(id="1", cap=CAP), CAP, result.output)
        ).status
        == TaskStatus.CANCELLED
    )
    if phase != "waiting":
        prefix = "sync_" if phase == "dependencies" else ""
        assert result.output[prefix + "stdout"] == "partial stdout"
        assert result.output[prefix + "stderr"] == "partial stderr"
    else:
        assert calls == []


@pytest.mark.parametrize("assignment_fails", [False, True])
def test_windows_job_assigned_before_poll_and_always_closed(
    monkeypatch, tmp_path, assignment_fails
):
    events = []

    class Job:
        def assign_and_resume(self, pid):
            events.append("assign")
            if assignment_fails:
                raise OSError("cannot assign")

        def terminate(self):
            events.append("terminate")

        def close(self):
            events.append("close")

    process = Mock(pid=123, returncode=0)

    def poll():
        assert "assign" in events
        events.append("poll")
        return 0

    process.poll.side_effect = poll
    monkeypatch.setattr(rt, "_WINDOWS", True)
    monkeypatch.setattr(rt, "WindowsJob", Job)
    popen = Mock(return_value=process)
    monkeypatch.setattr(rt.subprocess, "Popen", popen)
    output = {}
    if assignment_fails:
        with pytest.raises(OSError, match="cannot assign"):
            rt.run_process(["app"], tmp_path, {}, b"", lambda: None, output)
    else:
        assert rt.run_process(["app"], tmp_path, {}, b"", lambda: None, output) == 0
    assert popen.call_args.kwargs["creationflags"] == 4
    assert events.index("assign") < events.index("poll")
    assert "terminate" in events and "close" in events
    process.wait.assert_called_once()
    assert "stdout" in output


def test_windows_job_api_owns_members_after_parent_exit(monkeypatch):
    events = []
    api = Mock()
    api.CreateJobObjectW.return_value = 17
    api.OpenProcess.return_value = 23
    api.AssignProcessToJobObject.side_effect = lambda *args: (
        events.append("assign") or True
    )

    def query(handle, kind, pointer, size, returned):
        ct.cast(pointer, ct.POINTER(win._Accounting)).contents.ActiveProcesses = 0
        return True

    api.QueryInformationJobObject.side_effect = query
    monkeypatch.setattr(win, "_kernel_api", lambda: api)
    monkeypatch.setattr(
        win.psutil, "Process", lambda pid: Mock(resume=lambda: events.append("resume"))
    )
    job = win.WindowsJob()
    limits = ct.cast(
        api.SetInformationJobObject.call_args.args[2], ct.POINTER(win._ExtendedLimits)
    ).contents
    assert limits.BasicLimitInformation.LimitFlags == 0x2000
    job.assign_and_resume(123)
    assert events == ["assign", "resume"]
    # No root PID lookup during cleanup; the Job handle owns every descendant.
    job.terminate()
    job.close()
    job.close()
    api.TerminateJobObject.assert_called_once_with(17, 1)
    assert api.CloseHandle.call_args_list == [((23,),), ((17,),)]


def test_parent_exit_does_not_leave_background_child(tmp_path):
    # Runs against native Job Objects on Windows and process groups on POSIX.
    pid_file = tmp_path / "child.pid"
    child = "import os,time;from pathlib import Path;Path('child.pid').write_text(str(os.getpid()));time.sleep(60)"
    parent = f"import subprocess,sys,time;from pathlib import Path;subprocess.Popen([sys.executable,'-c',{child!r}]);\nwhile not Path('child.pid').exists(): time.sleep(.01)\nprint('parent finished')"
    output = {}
    started = time.monotonic()

    def tick():
        if time.monotonic() - started > 10:
            raise TimeoutError("test process stalled")

    rt.run_process(
        [sys.executable, "-c", parent], tmp_path, dict(os.environ), b"", tick, output
    )
    pid = int(pid_file.read_text())
    try:
        deadline = time.monotonic() + 5
        while psutil.pid_exists(pid):
            if psutil.Process(pid).status() == psutil.STATUS_ZOMBIE:
                break
            assert time.monotonic() < deadline, "background child survived"
            time.sleep(0.01)
        assert "parent finished" in output["stdout"]
    finally:
        if psutil.pid_exists(pid):
            try:
                psutil.Process(pid).kill()
            except psutil.NoSuchProcess:
                pass


def test_windows_assignment_failure_never_resumes_unowned_process(monkeypatch):
    api = Mock()
    api.CreateJobObjectW.return_value = 17
    api.OpenProcess.return_value = 23
    api.AssignProcessToJobObject.return_value = False
    monkeypatch.setattr(win, "_kernel_api", lambda: api)
    monkeypatch.setattr(win, "_last_error", lambda: OSError("assignment rejected"))
    resume = Mock()
    monkeypatch.setattr(win.psutil, "Process", resume)
    job = win.WindowsJob()
    with pytest.raises(OSError, match="assignment rejected"):
        job.assign_and_resume(123)
    resume.assert_not_called()
    api.CloseHandle.assert_called_once_with(23)
    job.close()


def test_windows_failed_spawn_releases_job(monkeypatch, tmp_path):
    job = Mock()
    monkeypatch.setattr(rt, "_WINDOWS", True)
    monkeypatch.setattr(rt, "WindowsJob", lambda: job)
    monkeypatch.setattr(
        rt.subprocess, "Popen", Mock(side_effect=OSError("spawn failed"))
    )
    with pytest.raises(OSError, match="spawn failed"):
        rt.run_process(["app"], tmp_path, {}, b"", lambda: None, {})
    job.close.assert_called_once()


def test_windows_cleanup_failure_still_reaps_root_and_preserves_streams(
    monkeypatch, tmp_path
):
    job = Mock()
    job.terminate.side_effect = OSError("job termination failed")
    monkeypatch.setattr(rt, "_WINDOWS", True)
    monkeypatch.setattr(rt, "WindowsJob", lambda: job)
    process = Mock(pid=123, returncode=0)
    process.poll.return_value = 0

    def spawn(*args, **kwargs):
        kwargs["stdout"].write(b"partial stdout")
        kwargs["stderr"].write(b"partial stderr")
        return process

    monkeypatch.setattr(rt.subprocess, "Popen", spawn)
    output = {}
    with pytest.raises(OSError, match="job termination failed"):
        rt.run_process(["app"], tmp_path, {}, b"", lambda: None, output)
    job.close.assert_called_once()
    process.wait.assert_called_once()
    assert output["stdout"] == "partial stdout"
    assert output["stderr"] == "partial stderr"
