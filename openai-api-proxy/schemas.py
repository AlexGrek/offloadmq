"""OpenAI-compatible response builders and capability name helpers."""

import time
import uuid
from typing import Optional


# ---------------------------------------------------------------------------
# Capability name mapping
# ---------------------------------------------------------------------------

def capability_for_model(model: str) -> str:
    """Convert an OpenAI model name to an OffloadMQ capability string.

    Agents register capabilities like 'llm.mistral', 'llm.llama3', etc.
    We strip ':latest' or any tag suffix and prefix with 'llm.'.
    """
    name = model.split(":")[0]  # drop tag like ':latest'
    if name.startswith("llm."):
        return name
    return f"llm.{name}"


def extract_model_name(capability: str) -> str:
    """Inverse of capability_for_model — 'llm.mistral' -> 'mistral'."""
    if capability.startswith("llm."):
        return capability[4:]
    return capability


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
    import json

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
