#!/usr/bin/env python3
"""
OpenAI API Proxy for OffloadMQ

Listens on the Ollama/OpenAI port and translates OpenAI-compatible requests
into OffloadMQ urgent tasks. Supports streaming via task progress logs.
"""

import argparse
import json
import time
import uuid
import logging
from typing import Optional
from urllib.parse import quote

import requests
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

logger = logging.getLogger("openai-proxy")

# ---------------------------------------------------------------------------
# OffloadMQ Client
# ---------------------------------------------------------------------------

class OffloadMQClient:
    """Thin client for the OffloadMQ server's client API."""

    def __init__(self, server_url: str, api_key: str):
        self.base = server_url.rstrip("/")
        self.api_key = api_key

    # -- submit_blocking: blocks until agent finishes -----------------------
    def submit_blocking(self, capability: str, payload: dict, timeout: float = 300) -> dict:
        body = {
            "capability": capability,
            "urgent": True,
            "restartable": False,
            "payload": payload,
            "apiKey": self.api_key,
        }
        r = requests.post(
            f"{self.base}/api/task/submit_blocking",
            json=body,
            timeout=timeout,
        )
        r.raise_for_status()
        return r.json()

    # -- submit (non-blocking, non-urgent): returns task id immediately -----
    def submit_nonurgent(self, capability: str, payload: dict) -> dict:
        body = {
            "capability": capability,
            "urgent": False,
            "restartable": False,
            "payload": payload,
            "apiKey": self.api_key,
        }
        r = requests.post(
            f"{self.base}/api/task/submit",
            json=body,
            timeout=30,
        )
        r.raise_for_status()
        return r.json()

    # -- poll task status/progress ------------------------------------------
    def poll_task(self, cap: str, task_id: str) -> dict:
        encoded_cap = quote(cap, safe="")
        r = requests.post(
            f"{self.base}/api/task/poll/{encoded_cap}/{task_id}",
            json={"apiKey": self.api_key},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()

    # -- list online capabilities -------------------------------------------
    def capabilities_online(self) -> list[str]:
        r = requests.post(
            f"{self.base}/api/capabilities/online",
            json={"apiKey": self.api_key},
            timeout=10,
        )
        r.raise_for_status()
        return r.json()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def capability_for_model(model: str) -> str:
    """Convert an OpenAI model name to an OffloadMQ capability string.

    The agent registers capabilities like 'llm.mistral', 'llm.llama3', etc.
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
    """Build a single SSE chunk for streaming chat completions."""
    delta = {}
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


# ---------------------------------------------------------------------------
# FastAPI App
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
        models = []
        for cap in sorted(llm_caps):
            name = extract_model_name(cap)
            models.append({
                "id": name,
                "object": "model",
                "created": 0,
                "owned_by": "offloadmq",
            })

        return {"object": "list", "data": models}

    # -----------------------------------------------------------------------
    # POST /v1/chat/completions — main chat endpoint
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

        capability = capability_for_model(model)

        # Payload sent to the agent — matches what execute_llm_query expects
        payload = {
            "messages": messages,
            "model": model.split(":")[0],
            "stream": bool(stream),
        }
        # Forward optional parameters Ollama supports
        for key in ("temperature", "top_p", "top_k", "seed", "num_predict",
                     "stop", "repeat_penalty", "num_ctx"):
            if key in body:
                payload[key] = body[key]
        # Map OpenAI 'max_tokens' -> Ollama 'num_predict'
        if "max_tokens" in body and "num_predict" not in payload:
            payload["num_predict"] = body["max_tokens"]

        if not stream:
            return await _handle_blocking(model, capability, payload)
        else:
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
        payload = {**body, "stream": bool(stream)}

        if not stream:
            # Non-streaming: submit blocking task, return Ollama-native response
            try:
                result = mq.submit_blocking(capability, payload, timeout=300)
            except requests.HTTPError as e:
                raise HTTPException(e.response.status_code if e.response else 502, str(e))
            except Exception as e:
                raise HTTPException(502, str(e))

            output = result.get("result") or result.get("output") or {}
            return JSONResponse(output)
        else:
            # Streaming: submit non-blocking, poll progress logs
            return _handle_ollama_streaming(model, capability, payload)

    # -----------------------------------------------------------------------
    # Non-streaming chat completion
    # -----------------------------------------------------------------------
    async def _handle_blocking(model: str, capability: str, payload: dict):
        # For non-streaming, tell the agent not to stream either
        payload["stream"] = False

        try:
            result = mq.submit_blocking(capability, payload, timeout=300)
        except requests.HTTPError as e:
            status = e.response.status_code if e.response else 502
            detail = e.response.text if e.response else str(e)
            raise HTTPException(status, detail)
        except Exception as e:
            raise HTTPException(502, str(e))

        # The blocking response is an AssignedTask. The agent puts the Ollama
        # response in 'result'. Structure: {model, message: {role, content}, ...}
        output = result.get("result") or result.get("output") or {}
        message = output.get("message", {})
        content = message.get("content", "")

        return JSONResponse(make_chat_response(model, content))

    # -----------------------------------------------------------------------
    # Streaming chat completion (SSE)
    # -----------------------------------------------------------------------
    def _handle_streaming(model: str, capability: str, payload: dict):
        # Agent streams to Ollama, buffers tokens into progress log updates.
        # We submit as non-urgent (streaming requires polling logs, which
        # is not supported on urgent tasks via the client poll endpoint).
        payload["stream"] = True

        def generate():
            chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

            # Initial role chunk
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

            # Poll for progress until task completes
            prev_log_len = 0
            while True:
                time.sleep(0.5)
                try:
                    status_resp = mq.poll_task(cap, tid)
                except requests.HTTPError as e:
                    if e.response and e.response.status_code == 404:
                        # Task might have been cleaned up already
                        break
                    continue
                except Exception:
                    continue

                status = status_resp.get("status", "")

                # Extract new log content since last poll
                log = status_resp.get("log") or ""
                if len(log) > prev_log_len:
                    new_text = log[prev_log_len:]
                    prev_log_len = len(log)
                    yield make_chat_chunk(model, new_text, chunk_id)

                # Non-urgent poll returns TaskStatusResponse with 'output' field
                if isinstance(status, str) and status in ("completed", "failed", "canceled"):
                    output = status_resp.get("output") or {}
                    message = output.get("message", {})
                    full_content = message.get("content", "")
                    if len(full_content) > prev_log_len:
                        remaining = full_content[prev_log_len:]
                        yield make_chat_chunk(model, remaining, chunk_id)
                    break

            # Final chunk
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
                    message = output.get("message", {})
                    full_content = message.get("content", "")
                    if len(full_content) > prev_log_len:
                        remaining = full_content[prev_log_len:]
                        yield json.dumps({
                            "model": model,
                            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                            "message": {"role": "assistant", "content": remaining},
                            "done": False,
                        }) + "\n"
                    break

            # Final done message
            yield json.dumps({
                "model": model,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "message": {"role": "assistant", "content": ""},
                "done": True,
            }) + "\n"

        return StreamingResponse(generate(), media_type="application/x-ndjson")

    return app


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="OpenAI/Ollama API proxy backed by OffloadMQ"
    )
    parser.add_argument(
        "--port", type=int, default=11434,
        help="Port to listen on (default: 11434, Ollama's default)",
    )
    parser.add_argument(
        "--host", type=str, default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--server", type=str, default="http://localhost:3069",
        help="OffloadMQ server URL (default: http://localhost:3069)",
    )
    parser.add_argument(
        "--api-key", type=str, default="client_secret_key_123",
        help="OffloadMQ client API key",
    )
    parser.add_argument(
        "--log-level", type=str, default="info",
        choices=["debug", "info", "warning", "error"],
        help="Log level (default: info)",
    )

    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    mq = OffloadMQClient(args.server, args.api_key)

    # Quick connectivity check
    try:
        caps = mq.capabilities_online()
        llm_caps = [c for c in caps if c.startswith("llm.")]
        if llm_caps:
            logger.info("Online LLM capabilities: %s", ", ".join(llm_caps))
        else:
            logger.warning("No LLM capabilities online — requests will fail until an agent registers")
    except Exception as e:
        logger.warning("Could not reach OffloadMQ server at %s: %s", args.server, e)
        logger.warning("Proxy will start anyway — requests will fail until the server is reachable")

    app = create_app(mq)

    logger.info("Starting OpenAI API proxy on %s:%d", args.host, args.port)
    logger.info("OffloadMQ server: %s", args.server)
    logger.info("Endpoints:")
    logger.info("  OpenAI:  POST http://%s:%d/v1/chat/completions", args.host, args.port)
    logger.info("  Ollama:  POST http://%s:%d/api/chat", args.host, args.port)
    logger.info("  Models:  GET  http://%s:%d/v1/models", args.host, args.port)

    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)


if __name__ == "__main__":
    main()
