"""Failed tasks must always carry a readable reason.

`str(exc)` is empty for timeouts, and the server only copies the failure
message into an *empty* output, so OAI chat used to show a reasonless
"failed" / "Unknown error" for exactly the failures worth debugging.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

import pytest

from offloadmq_agent.context import ExecContext
from offloadmq_agent.exec import llm as llm_exec
from offloadmq_agent.models import Task, TaskResult, TaskStatus, describe_exception
from offloadmq_agent.result_convert import task_result_to_wire


def test_describe_exception_is_never_empty() -> None:
    assert describe_exception(TimeoutError()) == "TimeoutError: timed out"
    assert describe_exception(asyncio.TimeoutError()) == "TimeoutError: timed out"
    assert describe_exception(ValueError()) == "ValueError (no message)"
    assert describe_exception(ConnectionError("refused")) == "ConnectionError: refused"
    # Our own RuntimeErrors are already phrased for humans.
    assert describe_exception(RuntimeError("Ollama error: oom")) == "Ollama error: oom"


def test_failure_with_output_still_names_its_reason() -> None:
    result = TaskResult(
        task_id="1", status=TaskStatus.FAILED, error="boom", output={"partial": "half"}
    )
    wire = task_result_to_wire("1", "llm.m", result)
    assert wire["status"] == {"failure": ["boom", 1.0]}
    assert wire["output"] == {"partial": "half", "error": "boom"}


def test_failure_without_output_keeps_it_empty_for_the_server_to_fill() -> None:
    wire = task_result_to_wire("1", "llm.m", TaskResult(task_id="1", status=TaskStatus.FAILED))
    assert wire["output"] == {}
    assert wire["status"]["failure"][0] == "task failed (the executor gave no reason)"


class _TimingOutContent:
    def __aiter__(self) -> AsyncIterator[bytes]:
        async def gen() -> AsyncIterator[bytes]:
            yield json.dumps({"message": {"content": "partial "}}).encode() + b"\n"
            raise asyncio.TimeoutError()

        return gen()


class _Response:
    status = 200
    content = _TimingOutContent()


class _Ctx:
    def __init__(self, value: Any) -> None:
        self._value = value

    async def __aenter__(self) -> Any:
        return self._value

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class _Session(_Ctx):
    def __init__(self) -> None:
        super().__init__(self)

    def post(self, *args: Any, **kwargs: Any) -> _Ctx:
        return _Ctx(_Response())


def test_llm_timeout_reports_model_limit_and_partial_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(llm_exec.aiohttp, "ClientSession", lambda *a, **kw: _Session())
    ctx = ExecContext(log_sink=lambda entry: None, progress_reporter=lambda *a: None)
    task = Task(id="t1", capability="llm.qwen3:8b[tools]", payload={"prompt": "hi"})

    result = asyncio.run(llm_exec.execute_llm(task, ctx))

    assert result.status == TaskStatus.FAILED
    assert result.error is not None
    assert "qwen3:8b" in result.error
    assert "within its 600s runtime limit" in result.error
    assert result.output == {"partial": "partial "}


def _task(data: dict[str, Any]) -> Task:
    return Task(id="t", capability="llm.m", server_task={"data": data})


def test_runtime_limit_prefers_runtime_secs_then_timeout_secs() -> None:
    assert _task({"runtimeSecs": 900, "timeoutSecs": 1200}).runtime_limit_secs() == 900
    assert _task({"timeoutSecs": 1200}).runtime_limit_secs() == 1200
    assert _task({}).runtime_limit_secs() == 600
    assert _task({"runtimeSecs": 0, "timeoutSecs": "bad"}).runtime_limit_secs() == 600
    assert Task(id="t", capability="llm.m").runtime_limit_secs() == 600


def test_llm_uses_the_task_runtime_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    class _CapturingSession(_Session):
        def post(self, *args: Any, **kwargs: Any) -> _Ctx:
            seen["timeout"] = kwargs["timeout"]
            return super().post(*args, **kwargs)

    monkeypatch.setattr(llm_exec.aiohttp, "ClientSession", lambda *a, **kw: _CapturingSession())
    ctx = ExecContext(log_sink=lambda entry: None, progress_reporter=lambda *a: None)
    task = Task(
        id="t1",
        capability="llm.qwen3:8b",
        payload={"prompt": "hi"},
        server_task={"data": {"runtimeSecs": 900}},
    )

    result = asyncio.run(llm_exec.execute_llm(task, ctx))

    assert seen["timeout"].total == 900
    assert "within its 900s runtime limit" in (result.error or "")
