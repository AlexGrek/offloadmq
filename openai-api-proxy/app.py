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
)

logger = logging.getLogger("openai-proxy")


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
    # GET /v1/models  &  GET /api/tags — list available models
    # -----------------------------------------------------------------------
    @app.get("/v1/models")
    @app.get("/api/tags")
    async def list_models():
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
            "model": model.split(":")[0],
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

        return _handle_ollama_streaming(model, capability, payload)

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
        payload["stream"] = True

        def generate():
            chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
            yield make_chat_chunk(model, "", chunk_id)

            logger.info("Streaming: submitting non-urgent task for cap=%s", capability)
            try:
                submit_resp = mq.submit_nonurgent(capability, payload)
            except requests.HTTPError as e:
                error_msg = e.response.text if e.response else str(e)
                yield f"data: {json.dumps({'error': error_msg})}\n\n"
                yield "data: [DONE]\n\n"
                return
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
                yield "data: [DONE]\n\n"
                return

            task_id_obj = submit_resp.get("id", {})
            cap = task_id_obj.get("cap", capability)
            tid = task_id_obj.get("id", "")

            if not tid:
                yield f"data: {json.dumps({'error': 'No task ID returned'})}\n\n"
                yield "data: [DONE]\n\n"
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
                    yield make_chat_chunk(model, new_text, chunk_id)

                if isinstance(status, str) and status in ("completed", "failed", "canceled"):
                    output = status_resp.get("output") or {}
                    full_content = output.get("message", {}).get("content", "")
                    if len(full_content) > prev_log_len:
                        yield make_chat_chunk(model, full_content[prev_log_len:], chunk_id)
                    break

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
    # Ollama-native streaming (/api/chat with stream=true)
    # -----------------------------------------------------------------------
    def _handle_ollama_streaming(model: str, capability: str, payload: dict):
        payload["stream"] = True

        def generate():
            logger.info("Ollama streaming: submitting non-urgent task for cap=%s", capability)
            try:
                submit_resp = mq.submit_nonurgent(capability, payload)
            except Exception as e:
                yield json.dumps({"error": str(e)}) + "\n"
                return

            task_id_obj = submit_resp.get("id", {})
            cap = task_id_obj.get("cap", capability)
            tid = task_id_obj.get("id", "")

            if not tid:
                yield json.dumps({"error": "No task ID returned"}) + "\n"
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
                    yield json.dumps({
                        "model": model,
                        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "message": {"role": "assistant", "content": new_text},
                        "done": False,
                    }) + "\n"

                if isinstance(status, str) and status in ("completed", "failed", "canceled"):
                    output = status_resp.get("output") or {}
                    full_content = output.get("message", {}).get("content", "")
                    if len(full_content) > prev_log_len:
                        yield json.dumps({
                            "model": model,
                            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                            "message": {"role": "assistant", "content": full_content[prev_log_len:]},
                            "done": False,
                        }) + "\n"
                    break

            yield json.dumps({
                "model": model,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "message": {"role": "assistant", "content": ""},
                "done": True,
            }) + "\n"

        return StreamingResponse(generate(), media_type="application/x-ndjson")

    return app
