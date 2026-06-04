"""llm.* executor — calls Ollama for local inference."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import aiohttp

from offloadmq_agent.context import ExecContext
from offloadmq_agent.executor import register
from offloadmq_agent.models import Task, TaskResult, TaskStatus
from offloadmq_agent.ollama import get_ollama_base_url


async def _stream_with_cancel(
    resp: aiohttp.ClientResponse,
    collected: list[str],
    ctx: ExecContext,
) -> bool:
    """Stream Ollama tokens, aborting the HTTP connection immediately on cancel.

    Returns True if the cancel event fired before streaming completed,
    False on normal completion.
    """

    async def _read() -> None:
        async for line in resp.content:
            chunk = line.strip()
            if not chunk:
                continue
            try:
                data: dict[str, Any] = json.loads(chunk)
                token: str = (
                    data.get("message", {}).get("content", "")
                    or data.get("response", "")
                )
                if token:
                    collected.append(token)
            except json.JSONDecodeError:
                pass

    async def _watch_cancel() -> None:
        while not ctx.cancel_event.is_set():
            await asyncio.sleep(0.1)

    read_task = asyncio.create_task(_read())
    watch_task = asyncio.create_task(_watch_cancel())

    try:
        done, _ = await asyncio.wait(
            {read_task, watch_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        for t in (read_task, watch_task):
            if not t.done():
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass

    if read_task in done:
        exc = read_task.exception()
        if exc is not None:
            raise exc
        return False

    # watch_task fired first → cancel event was set while still streaming
    return True


@register("llm")
async def execute_llm(task: Task, ctx: ExecContext) -> TaskResult:
    model = task.capability.removeprefix("llm.")
    prompt: str = task.payload.get("prompt", "")
    messages: list[dict[str, Any]] = task.payload.get("messages", [])

    if not prompt and not messages:
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.FAILED,
            error="Payload missing 'prompt' or 'messages'",
        )

    if not messages:
        messages = [{"role": "user", "content": prompt}]

    await ctx.progress("generating", f"model={model}", messages=len(messages))

    body: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
    collected: list[str] = []

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{get_ollama_base_url()}/api/chat",
                json=body,
                timeout=aiohttp.ClientTimeout(total=600),
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    return TaskResult(
                        task_id=task.id,
                        status=TaskStatus.FAILED,
                        error=f"Ollama error {resp.status}: {error_text}",
                    )
                if ctx.cancelled:
                    await ctx.warn("cancelled before streaming started")
                    return TaskResult(
                        task_id=task.id,
                        status=TaskStatus.CANCELLED,
                        error="Cancelled by user",
                    )
                was_cancelled = await _stream_with_cancel(resp, collected, ctx)
    except Exception as exc:
        return TaskResult(task_id=task.id, status=TaskStatus.FAILED, error=str(exc))

    if was_cancelled:
        await ctx.warn("cancelled — stopping generation")
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.CANCELLED,
            error="Cancelled by user",
            output={"partial": "".join(collected)},
        )

    full_text = "".join(collected)
    await ctx.progress("done", f"tokens≈{len(collected)}", tokens=len(collected))
    return TaskResult(
        task_id=task.id,
        status=TaskStatus.COMPLETED,
        output={
            "model": model,
            "message": {"role": "assistant", "content": full_text},
            "done": True,
        },
    )
