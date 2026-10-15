"""OpenRouter-compatible API: `/api/v1/*` (mirror `src/api/openrouter/`).

Auth is ``Authorization: Bearer <client key>`` (``X-API-Key`` fallback; the
management token acts as an override), and errors use OpenRouter's envelope
``{"error": {"code": <http>, "message": ...}}`` instead of the AppError one.

Model ids resolve like the server: ``qwen3:8b``, ``llm.qwen3:8b`` and
``offloadmq/qwen3:8b`` all mean the base capability ``llm.qwen3:8b``; the
``models`` fallback list picks the first one with an online agent. Model
aliases (``OPENROUTER_MODEL_ALIASES``) are not modelled.

There is no task subsystem, so a chat completion for an online model returns
a canned assistant reply (as a single SSE chunk when ``stream`` is true).
"""

from __future__ import annotations

import json
import time
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .. import deps
from ..config import settings
from ..utils import base_capability, capability_attrs, time_sortable_uid

router = APIRouter()

CANNED_REPLY = "[offloadmock] canned reply: the mock does not run models."


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": status, "message": message}})


def _auth(request: Request) -> tuple[Optional[str], bool] | JSONResponse:
    """(api_key, mgmt_override) or an error response."""
    header = request.headers.get("Authorization", "")
    key = header[len("Bearer "):] if header.startswith("Bearer ") else request.headers.get("X-API-Key")
    key = (key or "").strip()
    if not key:
        return _error(401, "Missing Authorization: Bearer <client API key> header")
    if key == settings.management_token:
        return None, True
    if not deps.store.is_key_real_not_revoked(key):
        return _error(401, "Invalid API key")
    return key, False


def _capability_for(model: str) -> str:
    model = model.strip()
    model = model.removeprefix("offloadmq/").removeprefix("llm.")
    return f"llm.{base_capability(model)}"


def _key_allows(api_key: Optional[str], mgmt: bool, capability: str) -> bool:
    if mgmt:
        return True
    key = deps.store.find_active_key(api_key or "")
    return key is not None and deps.store.has_capability(key.capabilities, capability)


@router.get("/models")
async def list_models(request: Request):
    auth = _auth(request)
    if isinstance(auth, JSONResponse):
        return auth
    api_key, mgmt = auth
    models: dict[str, list[str]] = {}
    for cap in deps.store.online_capabilities(strip_extended=False):
        base = base_capability(cap)
        if not base.startswith("llm.") or not _key_allows(api_key, mgmt, base):
            continue
        attrs = models.setdefault(base[len("llm."):], [])
        attrs.extend(a for a in capability_attrs(cap) if a not in attrs)
    data = []
    for name, attrs in sorted(models.items()):
        vision = "vision" in attrs
        params = ["max_tokens", "temperature", "top_p", "top_k", "min_p", "seed", "stop",
                  "presence_penalty", "frequency_penalty", "repetition_penalty",
                  "response_format", "structured_outputs"]
        if "tools" in attrs:
            params += ["tools", "tool_choice"]
        data.append({
            "id": name,
            "canonical_slug": name,
            "name": f"OffloadMQ: {name}",
            "created": 0,
            "description": f"{name} served by OffloadMQ agents (Ollama)",
            "context_length": None,
            "architecture": {
                "modality": "text+image->text" if vision else "text->text",
                "input_modalities": ["text", "image"] if vision else ["text"],
                "output_modalities": ["text"],
                "tokenizer": "Other",
                "instruct_type": None,
            },
            "pricing": {"prompt": "0", "completion": "0", "request": "0", "image": "0"},
            "top_provider": {"context_length": None, "max_completion_tokens": None,
                             "is_moderated": False},
            "per_request_limits": None,
            "supported_parameters": params,
        })
    return JSONResponse(content={"data": data})


@router.get("/key")
async def key_info(request: Request):
    auth = _auth(request)
    if isinstance(auth, JSONResponse):
        return auth
    api_key, mgmt = auth
    return JSONResponse(content={"data": {
        "label": "management" if mgmt else f"{(api_key or '')[:6]}...",
        "usage": 0,
        "limit": None,
        "limit_remaining": None,
        "is_free_tier": False,
        "is_provisioning_key": False,
        "rate_limit": {"requests": -1, "interval": "10s"},
    }})


@router.post("/chat/completions")
async def chat_completions(request: Request):
    auth = _auth(request)
    if isinstance(auth, JSONResponse):
        return auth
    api_key, mgmt = auth
    try:
        body: Any = await request.json()
    except Exception as e:  # noqa: BLE001
        return _error(400, f"Invalid request body: {e}")
    if not isinstance(body, dict):
        return _error(400, "Invalid request body: expected an object")

    candidates: list[str] = []
    for m in [body.get("model"), *(body.get("models") or [])]:
        if isinstance(m, str) and m.strip() and m.strip() not in candidates:
            candidates.append(m.strip())
    if not candidates:
        return _error(400, "model is required")
    if not body.get("messages") and not body.get("prompt"):
        return _error(400, "Either messages or prompt is required")

    online = deps.store.online_capabilities(strip_extended=True)
    chosen: Optional[str] = None
    forbidden: Optional[str] = None
    for model in candidates:
        cap = _capability_for(model)
        if cap not in online:
            continue
        if not _key_allows(api_key, mgmt, cap):
            forbidden = forbidden or model
            continue
        chosen = model
        break
    if chosen is None:
        if forbidden:
            return _error(403, f"This API key is not allowed to use {forbidden}")
        return _error(404, f"No endpoints found for {candidates[0]}.")

    task_uid = time_sortable_uid()
    meta = {"id": f"gen-{task_uid}", "provider": "OffloadMQ", "model": chosen,
            "created": int(time.time())}
    usage = {"prompt_tokens": 0, "completion_tokens": len(CANNED_REPLY) // 4,
             "total_tokens": len(CANNED_REPLY) // 4, "cost": 0, "is_byok": False}
    headers = {"X-OffloadMQ-Task-Id": task_uid}

    if body.get("stream"):
        def events():
            def chunk(delta: dict, finish: Optional[str]) -> dict:
                return {**meta, "object": "chat.completion.chunk", "choices": [{
                    "index": 0, "delta": delta, "logprobs": None,
                    "finish_reason": finish, "native_finish_reason": finish}]}

            yield f"data: {json.dumps(chunk({'role': 'assistant', 'content': CANNED_REPLY}, None))}\n\n"
            yield f"data: {json.dumps({**chunk({'role': 'assistant', 'content': ''}, 'stop'), 'usage': usage})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(events(), media_type="text/event-stream", headers=headers)

    return JSONResponse(headers=headers, content={
        **meta,
        "object": "chat.completion",
        "choices": [{
            "index": 0, "logprobs": None, "finish_reason": "stop", "native_finish_reason": "stop",
            "message": {"role": "assistant", "content": CANNED_REPLY, "refusal": None},
        }],
        "usage": usage,
    })
