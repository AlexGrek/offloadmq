"""A finished task's result must reach the server, or be re-offered until it does.

The server counts a task against the agent's capacity until it is resolved. If a
resolve is lost — the socket dropped while the agent was uploading its output,
the process restarted, the executor died — the agent goes idle while the server
keeps the slot occupied and stops dispatching to it. Two mechanisms prevent that
and are covered here: results are queued until the server acknowledges them, and
every heartbeat carries the agent's claim so the server can reclaim whatever the
agent no longer holds.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from offloadmq_agent.client import OffloadMQClient, OffloadMQError
from offloadmq_agent.models import Task, TaskResult, TaskStatus
from offloadmq_core.orchestrator import Orchestrator


def _orchestrator(tmp_path: Path) -> Orchestrator:
    """An orchestrator pointed at a throwaway settings file (never written here)."""
    return Orchestrator(settings_path=tmp_path / "settings.json")


def _result(task_id: str = "t-1") -> TaskResult:
    return TaskResult(task_id=task_id, status=TaskStatus.COMPLETED, output={"ok": True})


def _task(task_id: str = "t-1", cap: str = "imggen.flux") -> Task:
    return Task(id=task_id, capability=cap)


class _FakeClient:
    """Stands in for OffloadMQClient: records resolves and fails on demand."""

    def __init__(self, failures: list[Exception | None]) -> None:
        self._failures = failures
        self.resolved: list[tuple[str, str]] = []
        self.heartbeats: list[list[dict[str, str]] | None] = []

    async def resolve(self, capability: str, result: TaskResult) -> None:
        outcome = self._failures.pop(0) if self._failures else None
        if outcome is not None:
            raise outcome
        self.resolved.append((capability, result.task_id))

    async def send_heartbeat(self, active: list[dict[str, str]] | None = None) -> None:
        self.heartbeats.append(active)


def test_undelivered_result_stays_queued_and_is_retried(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path)
    # Offline when the task finished: the result must be kept, not dropped.
    orch._schedule_resolve(_task(), _result())
    assert "t-1" in orch._pending_resolves

    # First retry never reaches the server (status 0 = no ack).
    client = _FakeClient([OffloadMQError("socket died", status=0)])
    asyncio.run(orch._flush_pending_resolves(client))  # type: ignore[arg-type]
    assert client.resolved == []
    assert "t-1" in orch._pending_resolves, "a lost resolve must stay queued"

    # Next session gets through and the result is finally handed over.
    client = _FakeClient([])
    asyncio.run(orch._flush_pending_resolves(client))  # type: ignore[arg-type]
    assert client.resolved == [("imggen.flux", "t-1")]
    assert orch._pending_resolves == {}


def test_server_rejection_is_not_retried(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path)
    orch._schedule_resolve(_task(), _result())

    # 499: the client cancelled the task. The server processed the frame and has
    # already freed the slot — re-sending forever would be pointless.
    client = _FakeClient([OffloadMQError("cancelled", status=499)])
    asyncio.run(orch._flush_pending_resolves(client))  # type: ignore[arg-type]
    assert orch._pending_resolves == {}


def test_claim_covers_running_and_undelivered_tasks(tmp_path: Path) -> None:
    orch = _orchestrator(tmp_path)
    orch._store.create(_task("running-1", "llm.qwen3:8b"))
    orch._schedule_resolve(_task("unacked-1", "imggen.flux"), _result("unacked-1"))

    claim = orch._active_claim()
    assert {"cap": "llm.qwen3:8b", "id": "running-1"} in claim
    # Still owed to the server, so still ours — reclaiming it would fail a task
    # whose result is sitting right here.
    assert {"cap": "imggen.flux", "id": "unacked-1"} in claim

    # Once accepted, the agent stops claiming it and the server frees the slot.
    asyncio.run(orch._flush_pending_resolves(_FakeClient([])))  # type: ignore[arg-type]
    assert orch._active_claim() == [{"cap": "llm.qwen3:8b", "id": "running-1"}]


def test_idle_agent_claims_nothing(tmp_path: Path) -> None:
    # The empty claim is what tells the server to release slots a restarted
    # agent no longer knows about, so it must be sent, not omitted.
    orch = _orchestrator(tmp_path)
    client = _FakeClient([])
    asyncio.run(orch._send_heartbeat(client))  # type: ignore[arg-type]
    assert client.heartbeats == [[]]


class _FakeWs:
    def __init__(self) -> None:
        self.closed = False
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, frame: dict[str, Any]) -> None:
        self.sent.append(frame)


def test_resolve_waits_for_the_server_ack() -> None:
    """A queued send is not delivery: resolve completes only on the server's ack."""

    async def scenario() -> None:
        client = OffloadMQClient("http://localhost:3069", "jwt")
        ws = _FakeWs()
        client._ws = ws  # type: ignore[assignment]

        async def ack() -> None:
            while not ws.sent:
                await asyncio.sleep(0)
            client.handle_ack(
                {"type": "response", "req_id": ws.sent[0]["req_id"], "status": 200}
            )

        await asyncio.gather(client.resolve("imggen.flux", _result()), ack())
        assert ws.sent[0]["action"] == "resolve_task"

    asyncio.run(scenario())


def test_resolve_reports_a_dead_socket_as_retryable() -> None:
    async def scenario() -> None:
        client = OffloadMQClient("http://localhost:3069", "jwt")
        ws = _FakeWs()
        client._ws = ws  # type: ignore[assignment]

        async def kill() -> None:
            while not ws.sent:
                await asyncio.sleep(0)
            client.fail_pending_acks("connection closed")

        with pytest.raises(OffloadMQError) as excinfo:
            await asyncio.gather(client.resolve("imggen.flux", _result()), kill())
        # status 0 == never processed by the server, so the caller retries it.
        assert excinfo.value.status == 0

    asyncio.run(scenario())


def test_server_error_ack_carries_its_status() -> None:
    async def scenario() -> None:
        client = OffloadMQClient("http://localhost:3069", "jwt")
        ws = _FakeWs()
        client._ws = ws  # type: ignore[assignment]

        async def ack() -> None:
            while not ws.sent:
                await asyncio.sleep(0)
            client.handle_ack(
                {
                    "type": "error",
                    "req_id": ws.sent[0]["req_id"],
                    "status": 499,
                    "error": {"message": "task cancelled"},
                }
            )

        with pytest.raises(OffloadMQError) as excinfo:
            await asyncio.gather(client.resolve("imggen.flux", _result()), ack())
        assert excinfo.value.status == 499

    asyncio.run(scenario())
