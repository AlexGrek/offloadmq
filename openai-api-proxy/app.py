"""FastAPI application — OpenAI / Ollama API proxy backed by OffloadMQ."""

import json
import logging
import time
import uuid

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from client import OffloadMQClient
from image_utils import process_messages
from schemas import (
    capability_for_model,
    extract_model_name,
    make_chat_chunk,
    make_chat_response,
    make_ollama_chunk,
    make_ollama_model_entry,
)

logger = logging.getLogger("openai-proxy")

_OLLAMA_VERSION = "0.6.0"
_TERMINAL_STATUSES = ("completed", "failed", "canceled")


# ---------------------------------------------------------------------------
# Shared streaming poll loop
# ---------------------------------------------------------------------------

def _poll_stream(mq: OffloadMQClient, capability: str, payload: dict):
    """Submit a non-urgent task and poll for progress.

    Yields ``(event, data)`` tuples:
    - ``("error", message)``   — fatal error, stop iteration
    - ``("text",  new_text)``  — incremental log content
    - ``("done",  output)``    — task finished, *output* may be ``{}``
    """
    payload["stream"] = True
    try:
        submit_resp = mq.submit_nonurgent(capability, payload)
    except Exception as e:
        yield ("error", str(e))
        return

    task_id_obj = submit_resp.get("id", {})
    cap = task_id_obj.get("cap", capability)
    tid = task_id_obj.get("id", "")

    if not tid:
        yield ("error", "No task ID returned")
        return

    prev_log_len = 0
    while True:
        time.sleep(0.5)
        try:
            status_resp = mq.poll_task(cap, tid)
        except requests.HTTPError as e:
            if e.response and e.response.status_code == 404:
                break
            continue
        except Exception:
            continue

        status = status_resp.get("status", "")
        log = status_resp.get("log") or ""

        if len(log) > prev_log_len:
            new_text = log[prev_log_len:]
            prev_log_len = len(log)
            yield ("text", new_text)

        if isinstance(status, str) and status in _TERMINAL_STATUSES:
            output = status_resp.get("output") or {}
            full_content = output.get("message", {}).get("content", "")
            if len(full_content) > prev_log_len:
                yield ("text", full_content[prev_log_len:])
            yield ("done", output)
            return

    yield ("done", {})


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app(mq: OffloadMQClient) -> FastAPI:
    app = FastAPI(title="OpenAI API Proxy (OffloadMQ)")

    # -----------------------------------------------------------------------
    # GET / — Ollama-style root check
    # -----------------------------------------------------------------------
    @app.get("/")
    async def root():
        return "Ollama is running"

    # -----------------------------------------------------------------------
    # GET /api/version — Ollama version
    # -----------------------------------------------------------------------
    @app.get("/api/version")
    async def ollama_version():
        return {"version": _OLLAMA_VERSION}

    # -----------------------------------------------------------------------
    # GET /v1/models — OpenAI model list
    # -----------------------------------------------------------------------
    @app.get("/v1/models")
    async def list_models_openai():
        try:
            caps = mq.capabilities_online()
        except Exception as e:
            raise HTTPException(502, f"Failed to reach OffloadMQ server: {e}")

        llm_caps = [c for c in caps if c.startswith("llm.")]
        models = [
            {
                "id": extract_model_name(cap),
                "object": "model",
                "created": 0,
                "owned_by": "offloadmq",
            }
            for cap in sorted(llm_caps)
        ]
        return {"object": "list", "data": models}

    # -----------------------------------------------------------------------
    # GET /api/tags — Ollama model list
    # -----------------------------------------------------------------------
    @app.get("/api/tags")
    async def list_models_ollama():
        try:
            caps = mq.capabilities_online()
        except Exception as e:
            raise HTTPException(502, f"Failed to reach OffloadMQ server: {e}")

        llm_caps = [c for c in caps if c.startswith("llm.")]
        models = [make_ollama_model_entry(extract_model_name(cap)) for cap in sorted(llm_caps)]
        return {"models": models}

    # -----------------------------------------------------------------------
    # GET /api/ps — list running/loaded models (online agents as proxy)
    # -----------------------------------------------------------------------
    @app.get("/api/ps")
    async def ollama_ps():
        try:
            caps = mq.capabilities_online()
        except Exception as e:
            raise HTTPException(502, f"Failed to reach OffloadMQ server: {e}")

        llm_caps = [c for c in caps if c.startswith("llm.")]
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        models = [
            {
                "name": extract_model_name(cap),
                "model": extract_model_name(cap),
                "size": 0,
                "digest": "",
                "details": {"format": "gguf", "family": "", "families": None,
                            "parameter_size": "", "quantization_level": ""},
                "expires_at": now,
                "size_vram": 0,
            }
            for cap in sorted(llm_caps)
        ]
        return {"models": models}

    # -----------------------------------------------------------------------
    # POST /api/show — model info
    # -----------------------------------------------------------------------
    @app.post("/api/show")
    async def ollama_show(request: Request):
        body = await request.json()
        name = body.get("name") or body.get("model", "")
        if not name:
            raise HTTPException(400, "name is required")

        try:
            caps = mq.capabilities_online()
        except Exception as e:
            raise HTTPException(502, f"Failed to reach OffloadMQ server: {e}")

        cap = capability_for_model(name)
        if cap not in caps:
            raise HTTPException(404, f"model '{name}' not found")

        base_name = name.split(":")[0]
        return {
            "modelfile": f"FROM {name}\n",
            "parameters": "",
            "template": "{{ .Prompt }}",
            "details": {
                "format": "gguf",
                "family": base_name,
                "families": [base_name],
                "parameter_size": "",
                "quantization_level": "",
            },
            "model_info": {},
        }

    # -----------------------------------------------------------------------
    # POST /v1/chat/completions — OpenAI chat endpoint
    # -----------------------------------------------------------------------
    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request):
        body = await request.json()

        model = body.get("model", "")
        messages = body.get("messages", [])
        stream = body.get("stream", False)

        if not model:
            raise HTTPException(400, "model is required")
        if not messages:
            raise HTTPException(400, "messages is required")

        messages = process_messages(messages)
        capability = capability_for_model(model)

        payload: dict = {
            "messages": messages,
            "model": model,
            "stream": bool(stream),
        }
        for key in ("temperature", "top_p", "top_k", "seed", "num_predict",
                    "stop", "repeat_penalty", "num_ctx"):
            if key in body:
                payload[key] = body[key]
        if "max_tokens" in body and "num_predict" not in payload:
            payload["num_predict"] = body["max_tokens"]

        if not stream:
            return await _handle_blocking(model, capability, payload)
        return _handle_streaming(model, capability, payload)

    # -----------------------------------------------------------------------
    # POST /api/generate — Ollama generate (completion) endpoint
    # -----------------------------------------------------------------------
    @app.post("/api/generate")
    async def ollama_generate(request: Request):
        body = await request.json()

        model = body.get("model", "")
        prompt = body.get("prompt", "")
        stream = body.get("stream", True)

        if not model:
            raise HTTPException(400, "model is required")

        # Convert prompt+system to messages for OffloadMQ
        messages = []
        if body.get("system"):
            messages.append({"role": "system", "content": body["system"]})
        messages.append({"role": "user", "content": prompt})

        capability = capability_for_model(model)
        payload: dict = {
            "model": model,
            "messages": messages,
            "stream": bool(stream),
        }
        for key in ("temperature", "top_p", "top_k", "seed", "num_predict",
                    "stop", "repeat_penalty", "num_ctx"):
            if key in body:
                payload[key] = body[key]
        for key, val in (body.get("options") or {}).items():
            if key not in payload:
                payload[key] = val

        if not stream:
            try:
                result = mq.submit_blocking(capability, payload, timeout=300)
            except requests.HTTPError as e:
                raise HTTPException(e.response.status_code if e.response else 502, str(e))
            except Exception as e:
                raise HTTPException(502, str(e))

            output = result.get("result") or result.get("output") or {}
            content = output.get("message", {}).get("content", "")
            return JSONResponse({
                "model": model,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "response": content,
                "done": True,
                "done_reason": "stop",
                "context": [],
                "total_duration": 0,
                "load_duration": 0,
                "prompt_eval_count": 0,
                "prompt_eval_duration": 0,
                "eval_count": 0,
                "eval_duration": 0,
            })

        return _handle_ollama_streaming(model, capability, payload, content_key="response")

    # -----------------------------------------------------------------------
    # POST /api/chat — Ollama native chat endpoint
    # -----------------------------------------------------------------------
    @app.post("/api/chat")
    async def ollama_chat(request: Request):
        body = await request.json()

        model = body.get("model", "")
        messages = body.get("messages", [])
        stream = body.get("stream", True)  # Ollama defaults to streaming

        if not model:
            raise HTTPException(400, "model is required")
        if not messages:
            raise HTTPException(400, "messages is required")

        capability = capability_for_model(model)
        payload = {**body, "messages": process_messages(messages), "stream": bool(stream)}

        if not stream:
            try:
                result = mq.submit_blocking(capability, payload, timeout=300)
            except requests.HTTPError as e:
                raise HTTPException(e.response.status_code if e.response else 502, str(e))
            except Exception as e:
                raise HTTPException(502, str(e))

            output = result.get("result") or result.get("output") or {}
            return JSONResponse(output)

        return _handle_ollama_streaming(model, capability, payload, content_key="message")

    # -----------------------------------------------------------------------
    # POST /api/pull — stub (models are provided by agents, not pulled)
    # -----------------------------------------------------------------------
    @app.post("/api/pull")
    async def ollama_pull(request: Request):
        body = await request.json()
        name = body.get("name") or body.get("model", "")
        stream = body.get("stream", True)
        if stream:
            def _pull_stream():
                yield json.dumps({"status": f"pulling {name}"}) + "\n"
                yield json.dumps({"status": "success"}) + "\n"
            return StreamingResponse(_pull_stream(), media_type="application/x-ndjson")
        return JSONResponse({"status": "success"})

    # -----------------------------------------------------------------------
    # POST /api/push — stub
    # -----------------------------------------------------------------------
    @app.post("/api/push")
    async def ollama_push(request: Request):
        body = await request.json()
        stream = body.get("stream", True)
        if stream:
            def _push_stream():
                yield json.dumps({"status": "success"}) + "\n"
            return StreamingResponse(_push_stream(), media_type="application/x-ndjson")
        return JSONResponse({"status": "success"})

    # -----------------------------------------------------------------------
    # POST /api/copy — stub
    # -----------------------------------------------------------------------
    @app.post("/api/copy")
    async def ollama_copy(request: Request):
        return JSONResponse({}, status_code=200)

    # -----------------------------------------------------------------------
    # DELETE /api/delete — stub
    # -----------------------------------------------------------------------
    @app.delete("/api/delete")
    async def ollama_delete(request: Request):
        return JSONResponse({}, status_code=200)

    # -----------------------------------------------------------------------
    # POST /api/create — stub
    # -----------------------------------------------------------------------
    @app.post("/api/create")
    async def ollama_create(request: Request):
        body = await request.json()
        stream = body.get("stream", True)
        if stream:
            def _create_stream():
                yield json.dumps({"status": "success"}) + "\n"
            return StreamingResponse(_create_stream(), media_type="application/x-ndjson")
        return JSONResponse({"status": "success"})

    # -----------------------------------------------------------------------
    # POST /api/embed  &  POST /api/embeddings — not supported
    # -----------------------------------------------------------------------
    @app.post("/api/embed")
    async def ollama_embed(request: Request):
        raise HTTPException(501, "Embeddings are not supported by this proxy")

    @app.post("/api/embeddings")
    async def ollama_embeddings(request: Request):
        raise HTTPException(501, "Embeddings are not supported by this proxy")

    # -----------------------------------------------------------------------
    # Non-streaming chat completion (OpenAI)
    # -----------------------------------------------------------------------
    async def _handle_blocking(model: str, capability: str, payload: dict):
        payload["stream"] = False
        try:
            result = mq.submit_blocking(capability, payload, timeout=300)
        except requests.HTTPError as e:
            status = e.response.status_code if e.response else 502
            detail = e.response.text if e.response else str(e)
            raise HTTPException(status, detail)
        except Exception as e:
            raise HTTPException(502, str(e))

        output = result.get("result") or result.get("output") or {}
        message = output.get("message", {})
        content = message.get("content", "")
        return JSONResponse(make_chat_response(model, content))

    # -----------------------------------------------------------------------
    # Streaming chat completion (OpenAI SSE)
    # -----------------------------------------------------------------------
    def _handle_streaming(model: str, capability: str, payload: dict):
        def generate():
            chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
            yield make_chat_chunk(model, "", chunk_id)

            logger.info("Streaming: submitting non-urgent task for cap=%s", capability)
            for event, data in _poll_stream(mq, capability, payload):
                if event == "error":
                    yield f"data: {json.dumps({'error': data})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                if event == "text":
                    yield make_chat_chunk(model, data, chunk_id)

            yield make_chat_chunk(model, "", chunk_id, finish_reason="stop")
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # -----------------------------------------------------------------------
    # Ollama-native streaming (/api/generate and /api/chat)
    # -----------------------------------------------------------------------
    def _handle_ollama_streaming(model: str, capability: str, payload: dict,
                                 *, content_key: str):
        def generate():
            logger.info("Ollama streaming: submitting non-urgent task for cap=%s", capability)
            for event, data in _poll_stream(mq, capability, payload):
                if event == "error":
                    yield json.dumps({"error": data}) + "\n"
                    return
                if event == "text":
                    yield make_ollama_chunk(model, data, done=False,
                                           content_key=content_key)

            yield make_ollama_chunk(model, "", done=True,
                                   content_key=content_key, done_reason="stop")

        return StreamingResponse(generate(), media_type="application/x-ndjson")

    return app
