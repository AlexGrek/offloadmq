"""Runtime capability detection (async)."""
from __future__ import annotations

import asyncio
import shutil
from typing import Any

import aiohttp


async def _check_ollama(base_url: str = "http://localhost:11434") -> list[str]:
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{base_url}/api/tags", timeout=aiohttp.ClientTimeout(total=3)) as resp:
                if resp.status != 200:
                    return []
                data: dict[str, Any] = await resp.json()
                caps = []
                for model in data.get("models", []):
                    name: str = model.get("name", "")
                    if name:
                        base = name.split(":")[0]
                        caps.append(f"llm.{base}")
                return caps
    except Exception:
        return []


async def _check_shell() -> list[str]:
    caps = []
    if shutil.which("bash"):
        caps.append("shell.bash")
    if shutil.which("sh"):
        caps.append("shell.sh")
    return caps


async def detect_capabilities() -> list[str]:
    """Probe the local environment and return available capability strings."""
    results = await asyncio.gather(
        _check_ollama(),
        _check_shell(),
        return_exceptions=True,
    )
    caps: list[str] = ["debug.echo"]
    for result in results:
        if isinstance(result, list):
            caps.extend(result)
    return caps
