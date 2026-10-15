"""Integration tests for the OpenRouter-compatible API surface (``/api/v1``).

The test acts as a minimal WebSocket ``llm.*`` agent (register over HTTP, open
the socket, receive the pushed task, stream ``logUpdate`` deltas, resolve with
an Ollama-shaped output), so it needs only a running server — no Ollama.

The client side uses the official ``openai`` SDK pointed at ``/api/v1``: the
point of this surface is that an unmodified OpenAI/OpenRouter client works.

Covered behaviors:
- blocking completion: content, usage from agent counts, finish_reason
- request translation: sampling params arrive as Ollama ``options``
- streaming: chunks join to the full text, final chunk has usage, ``[DONE]``
- tool calls come back in OpenAI shape with ``finish_reason == "tool_calls"``
- ``models`` fallback list picks the online model
- errors: offline model 404, bad key 401, key without the capability 403,
  agent failure 502 — all in the ``{"error": {"code", "message"}}`` envelope
- client disconnect mid-stream cancels the task on the agent
- ``GET /models`` and ``GET /key``
"""
import json
import os
import threading
import time
import uuid

import openai
import pytest
import requests
import websocket

SERVER_URL = os.environ.get("OFFLOADMQ_URL", "http://localhost:3069")
WS_BASE = SERVER_URL.replace("http", "ws", 1) + "/private/agent/ws"
API_V1 = f"{SERVER_URL}/api/v1"
AGENT_API_KEY = "ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e"
CLIENT_API_KEY = "client_secret_key_123"
MGMT_TOKEN = "this-is-for-testing-management-tokens"


# ---------------------------------------------------------------------------
# Fake llm.* agent
# ---------------------------------------------------------------------------

def unique_model() -> str:
    return f"fake-{uuid.uuid4().hex[:10]}"


class FakeLlmAgent:
    """A WS agent serving ``llm.<model>[attrs]`` that runs one scripted task."""

    def __init__(self, model: str, attrs: str = ""):
        self.capability = f"llm.{model}"
        reg = requests.post(
            f"{SERVER_URL}/agent/register",
            json={
                "apiKey": AGENT_API_KEY,
                "capabilities": [f"{self.capability}{attrs}"],
                "tier": 5,
                "capacity": 1,
                "systemInfo": {
                    "os": "linux", "client": "pytest-openrouter", "runtime": "python3",
                    "cpuArch": "x86_64", "totalMemoryGb": 8,
                },
                "appVersion": "itest",
            },
            timeout=30,
        )
        reg.raise_for_status()
        data = reg.json()
        auth = requests.post(
            f"{SERVER_URL}/agent/auth",
            json={"agentId": data["agentId"], "key": data["key"]},
            timeout=30,
        )
        auth.raise_for_status()
        self.ws = websocket.create_connection(
            f"{WS_BASE}?token={auth.json()['token']}", timeout=10
        )
        self.task: dict | None = None
        self.cancelled = threading.Event()
        self._thread: threading.Thread | None = None

    def _recv(self, wanted: str, timeout: float) -> dict | None:
        deadline = time.time() + timeout
        self.ws.settimeout(0.5)
        while time.time() < deadline:
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if not raw:
                continue
            msg = json.loads(raw)
            if msg.get("type") == wanted:
                return msg
        return None

    def _send(self, action: str, params: dict) -> None:
        self.ws.send(json.dumps(
            {"req_id": uuid.uuid4().hex, "action": action, "params": params}
        ))

    def _progress(self, text: str) -> None:
        self._send("update_progress", {
            "id": self.task["id"], "stage": "running", "status": "running",
            "logUpdate": text,
        })

    def serve(self, deltas: list[str], output: dict | None = None, *,
              success: bool = True, error: str = "boom", wait_cancel: bool = False,
              delay: float = 0.3) -> None:
        """In a background thread: take the pushed task, stream ``deltas``,
        then resolve (or, with ``wait_cancel``, wait for a cancel frame)."""

        def run():
            push = self._recv("task", timeout=15)
            if push is None:
                return
            self.task = push["task"]
            for d in deltas:
                self._progress(d)
                time.sleep(delay)
            if wait_cancel:
                if self._recv("cancel", timeout=20) is not None:
                    self.cancelled.set()
                return
            status = {"success": 0.1} if success else {"failure": [error, 0.1]}
            self._send("resolve_task", {
                "id": self.task["id"],
                "capability": self.capability,
                "status": status,
                "output": output if success else {},
            })

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def join(self, timeout: float = 20) -> None:
        if self._thread:
            self._thread.join(timeout)

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass


def ollama_output(model: str, content: str, **extra) -> dict:
    return {
        "model": model,
        "message": {"role": "assistant", "content": content, **extra.pop("message_extra", {})},
        "done": True,
        "done_reason": "stop",
        **extra,
    }


@pytest.fixture
def client() -> openai.OpenAI:
    return openai.OpenAI(base_url=API_V1, api_key=CLIENT_API_KEY, max_retries=0, timeout=60)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_blocking_completion(client):
    model = unique_model()
    agent = FakeLlmAgent(model)
    try:
        agent.serve(
            ["Hello", ", world"],
            ollama_output(model, "Hello, world", prompt_eval_count=11, eval_count=4),
        )
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": "say hi"},
            ],
            temperature=0.2,
            max_tokens=32,
            stop=["END"],
        )
        agent.join()

        assert resp.choices[0].message.content == "Hello, world"
        assert resp.choices[0].finish_reason == "stop"
        assert resp.model == model
        assert resp.id.startswith("gen-")
        assert resp.usage.prompt_tokens == 11
        assert resp.usage.completion_tokens == 4
        assert resp.usage.total_tokens == 15

        # The agent received an Ollama-native payload on the base capability.
        task = agent.task
        assert task["id"]["cap"] == f"llm.{model}"
        payload = task["data"]["payload"]
        assert payload["stream"] is True
        assert payload["messages"][1] == {"role": "user", "content": "say hi"}
        assert payload["options"] == {"temperature": 0.2, "num_predict": 32, "stop": ["END"]}
    finally:
        agent.close()


def test_model_prefixes_are_accepted(client):
    model = unique_model()
    agent = FakeLlmAgent(model)
    try:
        agent.serve([], ollama_output(model, "ok"))
        resp = client.chat.completions.create(
            model=f"offloadmq/{model}", messages=[{"role": "user", "content": "x"}]
        )
        agent.join()
        assert resp.choices[0].message.content == "ok"
        assert resp.model == f"offloadmq/{model}"
    finally:
        agent.close()


def test_streaming_completion(client):
    model = unique_model()
    agent = FakeLlmAgent(model)
    try:
        deltas = ["The ", "quick ", "brown ", "fox"]
        agent.serve(
            deltas,
            ollama_output(model, "".join(deltas), prompt_eval_count=3, eval_count=4),
            delay=0.4,
        )
        stream = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "go"}],
            stream=True,
        )
        chunks = list(stream)
        agent.join()

        text = "".join(c.choices[0].delta.content or "" for c in chunks if c.choices)
        assert text == "The quick brown fox"
        # Text arrives incrementally, not as one final blob.
        content_chunks = [c for c in chunks if c.choices and c.choices[0].delta.content]
        assert len(content_chunks) >= 2
        assert content_chunks[0].choices[0].delta.role == "assistant"
        last = chunks[-1]
        assert last.choices[0].finish_reason == "stop"
        assert last.usage.prompt_tokens == 3
        assert last.usage.completion_tokens == 4
    finally:
        agent.close()


def test_stream_ends_with_done_marker():
    model = unique_model()
    agent = FakeLlmAgent(model)
    try:
        agent.serve(["a", "b"], ollama_output(model, "ab"))
        with requests.post(
            f"{API_V1}/chat/completions",
            headers={"Authorization": f"Bearer {CLIENT_API_KEY}"},
            json={"model": model, "stream": True,
                  "messages": [{"role": "user", "content": "x"}]},
            stream=True,
            timeout=60,
        ) as r:
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            assert r.headers.get("x-offloadmq-task-id")
            data_lines = [
                line[len("data: "):] for line in r.iter_lines(decode_unicode=True)
                if line and line.startswith("data: ")
            ]
        agent.join()
        assert data_lines[-1] == "[DONE]"
        objs = [json.loads(d) for d in data_lines[:-1]]
        assert all(o["object"] == "chat.completion.chunk" for o in objs)
        assert "usage" in objs[-1]
    finally:
        agent.close()


def test_tool_calls(client):
    model = unique_model()
    agent = FakeLlmAgent(model, "[tools]")
    try:
        agent.serve([], ollama_output(model, "", message_extra={"tool_calls": [
            {"function": {"name": "get_weather", "arguments": {"city": "Kyiv"}}}
        ]}))
        tools = [{"type": "function", "function": {
            "name": "get_weather",
            "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
        }}]
        resp = client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": "weather?"}], tools=tools
        )
        agent.join()

        choice = resp.choices[0]
        assert choice.finish_reason == "tool_calls"
        call = choice.message.tool_calls[0]
        assert call.type == "function"
        assert call.function.name == "get_weather"
        assert json.loads(call.function.arguments) == {"city": "Kyiv"}
        assert agent.task["data"]["payload"]["tools"] == tools
    finally:
        agent.close()


def test_models_fallback_picks_online_model(client):
    model = unique_model()
    agent = FakeLlmAgent(model)
    try:
        agent.serve([], ollama_output(model, "fallback ok"))
        resp = client.chat.completions.create(
            model=unique_model(),  # nothing serves this one
            messages=[{"role": "user", "content": "x"}],
            extra_body={"models": [model]},
        )
        agent.join()
        assert resp.choices[0].message.content == "fallback ok"
        assert resp.model == model
    finally:
        agent.close()


def test_offline_model_is_404(client):
    with pytest.raises(openai.NotFoundError) as exc:
        client.chat.completions.create(
            model=unique_model(), messages=[{"role": "user", "content": "x"}]
        )
    assert "No endpoints found" in exc.value.body["message"]


def test_bad_key_is_401():
    bad = openai.OpenAI(base_url=API_V1, api_key="nope", max_retries=0)
    with pytest.raises(openai.AuthenticationError):
        bad.models.list()
    r = requests.get(f"{API_V1}/models", timeout=10)
    assert r.status_code == 401
    assert r.json()["error"]["code"] == 401


def test_key_without_capability_is_403():
    model = unique_model()
    agent = FakeLlmAgent(model)
    key = f"itest-restricted-{uuid.uuid4().hex[:8]}"
    created = requests.post(
        f"{SERVER_URL}/management/client_api_keys/update",
        headers={"Authorization": f"Bearer {MGMT_TOKEN}"},
        json={"key": key, "capabilities": ["debug.*"]},
        timeout=10,
    )
    created.raise_for_status()
    try:
        restricted = openai.OpenAI(base_url=API_V1, api_key=key, max_retries=0)
        with pytest.raises(openai.PermissionDeniedError):
            restricted.chat.completions.create(
                model=model, messages=[{"role": "user", "content": "x"}]
            )
        # ...and the model isn't listed for that key either.
        ids = [m.id for m in restricted.models.list().data]
        assert model not in ids
    finally:
        agent.close()
        requests.post(
            f"{SERVER_URL}/management/client_api_keys/revoke/{key}",
            headers={"Authorization": f"Bearer {MGMT_TOKEN}"},
            timeout=10,
        )


def test_agent_failure_is_502(client):
    model = unique_model()
    agent = FakeLlmAgent(model)
    try:
        agent.serve([], success=False, error="Ollama error 500: model not found")
        with pytest.raises(openai.APIStatusError) as exc:
            client.chat.completions.create(
                model=model, messages=[{"role": "user", "content": "x"}]
            )
        agent.join()
        assert exc.value.status_code == 502
        assert "model not found" in exc.value.body["message"]
    finally:
        agent.close()


def test_client_disconnect_cancels_task():
    model = unique_model()
    agent = FakeLlmAgent(model)
    try:
        agent.serve(["partial "], wait_cancel=True)
        with requests.post(
            f"{API_V1}/chat/completions",
            headers={"Authorization": f"Bearer {CLIENT_API_KEY}"},
            json={"model": model, "stream": True,
                  "messages": [{"role": "user", "content": "x"}]},
            stream=True,
            timeout=60,
        ) as r:
            for line in r.iter_lines(decode_unicode=True):
                if line and line.startswith("data: ") and "partial" in line:
                    break
        # Leaving the `with` closes the connection mid-stream. The server
        # notices on its next send (progress or the 15 s keep-alive).
        assert agent.cancelled.wait(timeout=25), "agent should receive a cancel frame"
    finally:
        agent.close()


def test_models_and_key(client):
    model = unique_model()
    agent = FakeLlmAgent(model, "[vision;tools]")
    try:
        models = {m.id: m for m in client.models.list().data}
        assert model in models
        entry = models[model].model_dump()
        assert entry["architecture"]["input_modalities"] == ["text", "image"]
        assert "tools" in entry["supported_parameters"]
        assert entry["pricing"]["prompt"] == "0"

        r = requests.get(
            f"{API_V1}/key",
            headers={"Authorization": f"Bearer {CLIENT_API_KEY}"},
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json()["data"]["usage"] == 0
    finally:
        agent.close()
