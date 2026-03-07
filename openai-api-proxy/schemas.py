"""OpenAI-compatible response builders and capability name helpers."""

import json
import time
import uuid
from typing import Optional


# ---------------------------------------------------------------------------
# Capability name mapping
# ---------------------------------------------------------------------------

def capability_for_model(model: str) -> str:
    """Convert an OpenAI/Ollama model name to an OffloadMQ capability string.

    Agents register capabilities like 'llm.mistral', 'llm.llama3:13b', etc.
    Tag suffixes are preserved — they are used for task scheduling.
    """
    if model.startswith("llm."):
        return model
    return f"llm.{model}"


def extract_model_name(capability: str) -> str:
    """Inverse of capability_for_model — 'llm.mistral' -> 'mistral'."""
    if capability.startswith("llm."):
        return capability[4:]
    return capability


# ---------------------------------------------------------------------------
# Ollama response builders
# ---------------------------------------------------------------------------

def make_ollama_model_entry(name: str) -> dict:
    """Build an Ollama-compatible model entry for /api/tags."""
    tag = name if ":" in name else f"{name}:latest"
    return {
        "name": tag,
        "model": tag,
        "modified_at": "1970-01-01T00:00:00Z",
        "size": 0,
        "digest": "",
        "details": {
            "format": "gguf",
            "family": name.split(":")[0],
            "families": [name.split(":")[0]],
            "parameter_size": "",
            "quantization_level": "",
        },
    }


def make_ollama_chunk(model: str, content: str, *, done: bool,
                      content_key: str = "response",
                      done_reason: str | None = None) -> str:
    """Build a single ndjson line for Ollama streaming.

    content_key: 'response' for /api/generate, 'message' for /api/chat.
    """
    obj: dict = {
        "model": model,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "done": done,
    }
    if content_key == "message":
        obj["message"] = {"role": "assistant", "content": content}
    else:
        obj["response"] = content

    if done:
        if done_reason:
            obj["done_reason"] = done_reason
        if content_key == "response":
            obj.update({
                "context": [],
                "total_duration": 0,
                "load_duration": 0,
                "prompt_eval_count": 0,
                "prompt_eval_duration": 0,
                "eval_count": 0,
                "eval_duration": 0,
            })
    return json.dumps(obj) + "\n"


# ---------------------------------------------------------------------------
# OpenAI response builders
# ---------------------------------------------------------------------------

def make_chat_response(
    model: str,
    content: str,
    finish_reason: str = "stop",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> dict:
    """Build an OpenAI-compatible chat completion response."""
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


def make_chat_chunk(
    model: str,
    content: str,
    chunk_id: str,
    finish_reason: Optional[str] = None,
) -> str:
    """Build a single SSE data line for streaming chat completions."""
    delta: dict = {}
    if content:
        delta["content"] = content
    if finish_reason is None and not content:
        delta["role"] = "assistant"

    chunk = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {json.dumps(chunk)}\n\n"
