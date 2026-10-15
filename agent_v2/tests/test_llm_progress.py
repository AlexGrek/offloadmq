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
    # Body of the last /api/chat request, for asserting what reached Ollama.
    last_body: dict[str, Any] = {}

    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False

    def post(self, *args: Any, **kwargs: Any) -> _AsyncCtx:
        _FakeSession.last_body = kwargs.get("json", {})
        return _AsyncCtx(_FakeResponse(self._lines))


def _token(text: str) -> bytes:
    return json.dumps({"message": {"content": text}}).encode() + b"\n"


def _run_llm(
    monkeypatch: pytest.MonkeyPatch,
    lines: list[bytes],
    payload: dict[str, Any] | None = None,
) -> tuple[Any, list[tuple[str, str]]]:
    monkeypatch.setattr(
        llm_exec.aiohttp, "ClientSession", lambda *a, **kw: _FakeSession(lines)
    )
    reported: list[tuple[str, str]] = []
    ctx = ExecContext(
        log_sink=lambda entry: None,
        progress_reporter=lambda stage, message, _extra: reported.append((stage, message)),
    )
    task = Task(id="t1", capability="llm.qwen3:8b", payload=payload or {"prompt": "hi"})
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


def _chunk(**fields: Any) -> bytes:
    return json.dumps(fields).encode() + b"\n"


def test_ollama_request_fields_are_forwarded(monkeypatch: pytest.MonkeyPatch) -> None:
    tools = [{"type": "function", "function": {"name": "f", "parameters": {}}}]
    payload = {
        "messages": [{"role": "user", "content": "hi"}],
        "options": {"temperature": 0.2, "num_predict": 16},
        "format": "json",
        "tools": tools,
        "think": True,
        "unrelated": "dropped",
    }
    _run_llm(monkeypatch, [_token("ok")], payload)

    body = _FakeSession.last_body
    assert body["options"] == {"temperature": 0.2, "num_predict": 16}
    assert body["format"] == "json"
    assert body["tools"] == tools
    assert body["think"] is True
    assert body["stream"] is True
    assert "unrelated" not in body


def test_output_carries_thinking_tool_calls_and_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    call = {"function": {"name": "f", "arguments": {"x": 1}}}
    lines = [
        _chunk(message={"role": "assistant", "content": "", "thinking": "let me "}),
        _chunk(message={"role": "assistant", "content": "", "thinking": "think"}),
        _chunk(message={"role": "assistant", "content": "answer", "tool_calls": [call]}),
        _chunk(
            message={"role": "assistant", "content": ""},
            done=True,
            done_reason="stop",
            prompt_eval_count=12,
            eval_count=5,
        ),
    ]
    result, reported = _run_llm(monkeypatch, lines)

    assert result.status == TaskStatus.COMPLETED
    out = result.output
    assert out["message"]["content"] == "answer"
    assert out["message"]["thinking"] == "let me think"
    assert out["message"]["tool_calls"] == [call]
    assert out["done_reason"] == "stop"
    assert out["prompt_eval_count"] == 12
    assert out["eval_count"] == 5
    # Reasoning stays out of the progress log — the log is the reply text.
    assert "".join(msg for _, msg in reported) == "answer"


def test_plain_reply_output_shape_is_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    result, _ = _run_llm(monkeypatch, [_token("hi")])
    assert result.output == {
        "model": "qwen3:8b",
        "message": {"role": "assistant", "content": "hi"},
        "done": True,
    }


def test_in_stream_ollama_error_fails_the_task(monkeypatch: pytest.MonkeyPatch) -> None:
    result, _ = _run_llm(monkeypatch, [_token("par"), _chunk(error="model crashed")])
    assert result.status == TaskStatus.FAILED
    assert "model crashed" in (result.error or "")
