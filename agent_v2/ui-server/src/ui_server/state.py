"""Shared mutable server state — agent lifecycle + log ring buffer."""
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentState:
    running: bool = False
    agent_id: str = ""
    capabilities: list[str] = field(default_factory=list)
    logs: deque[str] = field(default_factory=lambda: deque(maxlen=500))
    _task: asyncio.Task[None] | None = field(default=None, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    def append_log(self, msg: str) -> None:
        self.logs.append(msg)

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "agentId": self.agent_id,
            "capabilities": self.capabilities,
        }


# Module-level singleton — one server process = one agent state.
agent_state = AgentState()
