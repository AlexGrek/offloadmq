"""llm.* executor — calls Ollama for local inference."""
from __future__ import annotations

import json
from typing import Any, Callable, Coroutine

import aiohttp

from offloadmq_agent.executor import register
from offloadmq_agent.models import Task, TaskResult, TaskStatus

_OLLAMA_BASE = "http://localhost:11434"


@register("llm")
async def execute_llm(
    task: Task,
    report_progress: Callable[[str, str], Coroutine[Any, Any, None]],
) -> TaskResult:
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

    await report_progress("generating", f"model={model} messages={len(messages)}")

    body: dict[str, Any] = {"model": model, "messages": messages, "stream": True}

    collected: list[str] = []
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{_OLLAMA_BASE}/api/chat",
                json=body,
                timeout=aiohttp.ClientTimeout(total=300),
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    return TaskResult(
                        task_id=task.id,
                        status=TaskStatus.FAILED,
                        error=f"Ollama error {resp.status}: {error_text}",
                    )
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
    except Exception as exc:
        return TaskResult(
            task_id=task.id,
            status=TaskStatus.FAILED,
            error=str(exc),
        )

    full_text = "".join(collected)
    await report_progress("done", f"tokens≈{len(collected)}")
    return TaskResult(
        task_id=task.id,
        status=TaskStatus.COMPLETED,
        output={"text": full_text, "model": model},
    )
