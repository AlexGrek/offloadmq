"""Runtime capability detection (async entry point)."""
from __future__ import annotations

import asyncio
from typing import Callable

from offloadmq_agent.cap_policy import classify_capabilities, compute_registration_caps
from offloadmq_agent.capabilities_sync import detect_capabilities as detect_capabilities_sync

__all__ = [
    "detect_capabilities",
    "detect_capabilities_sync",
    "classify_capabilities",
    "compute_registration_caps",
]


async def detect_capabilities(
    log_fn: Callable[[str], None] | None = None,
) -> list[str]:
    """Probe the local environment and return available capability strings."""
    return await asyncio.to_thread(detect_capabilities_sync, log_fn)
