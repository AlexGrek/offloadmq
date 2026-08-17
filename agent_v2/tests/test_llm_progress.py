"""The llm.* executor must move the server-side status off `assigned`.

A pushed task is `assigned` until a progress update carries a Starting/Running
status; the LLM executor used to send its first progress only once tokens had
been buffered for 2 s, so a slow model load left the task looking unstarted.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

import pytest

from offloadmq_agent.context import ExecContext
from offloadmq_agent.exec import llm as llm_exec
from offloadmq_agent.models import Task, TaskStatus
from offloadmq_agent.wire import progress_wire_status


class _FakeContent:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines

    def __aiter__(self) -> AsyncIterator[bytes]:
        async def gen() -> AsyncIterator[bytes]:
            for line in self._lines:
                yield line

        return gen()


class _FakeResponse:
    def __init__(self, lines: list[bytes], status: int = 200) -> None:
        self.status = status
        self.content = _FakeContent(lines)

    async def text(self) -> str:
        return ""


class _AsyncCtx:
    def __init__(self, value: Any) -> None:
        self._value = value

    async def __aenter__(self) -> Any:
        return self._value

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class _FakeSession:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    def post(self, *args: Any, **kwargs: Any) -> _AsyncCtx:
        return _AsyncCtx(_FakeResponse(self._lines))


def _token(text: str) -> bytes:
    return json.dumps({"message": {"content": text}}).encode() + b"\n"


def _run_llm(monkeypatch: pytest.MonkeyPatch, lines: list[bytes]) -> tuple[Any, list[tuple[str, str]]]:
    monkeypatch.setattr(
        llm_exec.aiohttp, "ClientSession", lambda *a, **kw: _FakeSession(lines)
    )
    reported: list[tuple[str, str]] = []
    ctx = ExecContext(
        log_sink=lambda entry: None,
        progress_reporter=lambda stage, message, _extra: reported.append((stage, message)),
    )
    task = Task(id="t1", capability="llm.qwen3:8b", payload={"prompt": "hi"})
    result = asyncio.run(llm_exec.execute_llm(task, ctx))
    return result, reported


def test_running_reported_before_any_token(monkeypatch: pytest.MonkeyPatch) -> None:
    result, reported = _run_llm(monkeypatch, [_token("hello "), _token("world")])

    assert result.status == TaskStatus.COMPLETED
    assert reported, "executor sent no progress at all"

    stage, message = reported[0]
    assert stage == "running"
    # Empty log: OAI chat renders the task log as the assistant reply, so the
    # status ping must not inject text into it.
    assert message == ""
    assert progress_wire_status(stage, bool(message)) == "running"


def test_generated_text_still_streams_as_log(monkeypatch: pytest.MonkeyPatch) -> None:
    result, reported = _run_llm(monkeypatch, [_token("hello "), _token("world")])

    assert result.output["message"]["content"] == "hello world"
    assert "".join(msg for _, msg in reported) == "hello world"
