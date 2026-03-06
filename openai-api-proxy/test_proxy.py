"""
Integration tests for the OpenAI API proxy.

Requires:
  - OffloadMQ server running on localhost:3069
  - At least one agent online with an llm.* capability
  - Proxy running on localhost:11434

Run: make test
"""

import json
import os
import requests
import pytest

OPENAI_PROXY_URL = os.environ.get("OPENAI_PROXY_URL", "http://localhost:11434")
MQ_URL = os.environ.get("MQ_URL", "http://localhost:3069")
API_KEY = os.environ.get("API_KEY", "client_secret_key_123")


def get_first_model() -> str:
    """Fetch the first available LLM model from the proxy."""
    resp = requests.get(f"{OPENAI_PROXY_URL}/v1/models", timeout=10)
    resp.raise_for_status()
    data = resp.json()["data"]
    if not data:
        pytest.skip("No LLM models online — need at least one agent with an llm.* capability")
    return data[0]["id"]


@pytest.fixture(scope="module")
def model():
    return get_first_model()


# ---------------------------------------------------------------------------
# Model listing
# ---------------------------------------------------------------------------

def test_list_models_openai():
    resp = requests.get(f"{OPENAI_PROXY_URL}/v1/models", timeout=10)
    assert resp.status_code == 200
    body = resp.json()
    assert body["object"] == "list"
    assert isinstance(body["data"], list)
    for m in body["data"]:
        assert "id" in m
        assert m["object"] == "model"


def test_list_models_ollama():
    resp = requests.get(f"{OPENAI_PROXY_URL}/api/tags", timeout=10)
    assert resp.status_code == 200
    body = resp.json()
    assert "data" in body


def test_root_ollama_compat():
    resp = requests.get(f"{OPENAI_PROXY_URL}/", timeout=5)
    assert resp.status_code == 200
    assert "Ollama is running" in resp.text


# ---------------------------------------------------------------------------
# Non-streaming chat completion (OpenAI format)
# ---------------------------------------------------------------------------

def test_chat_completion_non_streaming(model):
    resp = requests.post(
        f"{OPENAI_PROXY_URL}/v1/chat/completions",
        json={
            "model": model,
            "messages": [{"role": "user", "content": "Say hello in one word."}],
            "stream": False,
        },
        timeout=120,
    )
    assert resp.status_code == 200
    body = resp.json()

    assert body["object"] == "chat.completion"
    assert body["model"] == model
    assert len(body["choices"]) == 1

    choice = body["choices"][0]
    assert choice["message"]["role"] == "assistant"
    assert len(choice["message"]["content"]) > 0
    assert choice["finish_reason"] == "stop"
    assert "usage" in body


# ---------------------------------------------------------------------------
# Streaming chat completion (OpenAI SSE format)
# ---------------------------------------------------------------------------

def test_chat_completion_streaming(model):
    resp = requests.post(
        f"{OPENAI_PROXY_URL}/v1/chat/completions",
        json={
            "model": model,
            "messages": [{"role": "user", "content": "Say hello in one word."}],
            "stream": True,
        },
        stream=True,
        timeout=120,
    )
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers.get("content-type", "")

    chunks = []
    full_content = ""
    for line in resp.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        payload = line[len("data: "):]
        if payload == "[DONE]":
            break
        chunk = json.loads(payload)
        chunks.append(chunk)
        assert chunk["object"] == "chat.completion.chunk"
        delta = chunk["choices"][0]["delta"]
        if "content" in delta:
            full_content += delta["content"]

    assert len(chunks) >= 2  # at least role chunk + content + finish
    assert len(full_content) > 0

    # Last real chunk should have finish_reason
    last = chunks[-1]
    assert last["choices"][0]["finish_reason"] == "stop"


# ---------------------------------------------------------------------------
# Ollama native /api/chat — non-streaming
# ---------------------------------------------------------------------------

def test_ollama_chat_non_streaming(model):
    resp = requests.post(
        f"{OPENAI_PROXY_URL}/api/chat",
        json={
            "model": model,
            "messages": [{"role": "user", "content": "Say hello in one word."}],
            "stream": False,
        },
        timeout=120,
    )
    assert resp.status_code == 200
    body = resp.json()

    # Ollama native format: {model, message: {role, content}, done, ...}
    assert "message" in body
    assert body["message"]["role"] == "assistant"
    assert len(body["message"]["content"]) > 0


# ---------------------------------------------------------------------------
# Ollama native /api/chat — streaming (ndjson)
# ---------------------------------------------------------------------------

def test_ollama_chat_streaming(model):
    resp = requests.post(
        f"{OPENAI_PROXY_URL}/api/chat",
        json={
            "model": model,
            "messages": [{"role": "user", "content": "Say hello in one word."}],
            "stream": True,
        },
        stream=True,
        timeout=120,
    )
    assert resp.status_code == 200

    lines = []
    full_content = ""
    for raw_line in resp.iter_lines(decode_unicode=True):
        if not raw_line.strip():
            continue
        obj = json.loads(raw_line)
        lines.append(obj)
        full_content += obj.get("message", {}).get("content", "")

    assert len(lines) >= 2
    assert len(full_content) > 0

    # Last line should have done=True
    assert lines[-1]["done"] is True


# ---------------------------------------------------------------------------
# Error cases
# ---------------------------------------------------------------------------

def test_missing_model():
    resp = requests.post(
        f"{OPENAI_PROXY_URL}/v1/chat/completions",
        json={"messages": [{"role": "user", "content": "hi"}]},
        timeout=10,
    )
    assert resp.status_code == 400


def test_missing_messages(model):
    resp = requests.post(
        f"{OPENAI_PROXY_URL}/v1/chat/completions",
        json={"model": model, "messages": []},
        timeout=10,
    )
    assert resp.status_code == 400
