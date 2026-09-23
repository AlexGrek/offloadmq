---
name: debug-stack
description: >-
  Cross-surface debugging of the OffloadMQ task flow across all three surfaces:
  agent_v2 (Python executor), the Rust MQ backend (src/), and OAI (oai/).
  Use when a task-level symptom spans surfaces — stuck/missing statuses, progress
  bars not advancing, tasks black-holed after submit, missing poll fields
  (typicalRuntimeSeconds, stage, log), results not persisted, or when you need to
  decide WHICH surface owns a bug. Stack with agent-v2, oai-img/oai-chat, or
  oai-backend once the owning surface is identified.
---

# Debug Stack — Cross-Surface Task-Flow Debugging

A task travels through **three surfaces**; a symptom on one surface is often caused
upstream. This skill tells you how to observe each hop, reproduce locally, and
decide which surface owns the bug.

```
client (sandbox / OAI backend)
   │  POST /api/task/submit          {capability, urgent, payload, apiKey}
   ▼
MQ server (Rust, src/)               queued → assigned → starting/running → completed/failed/canceled
   │  WS push to agent               (agent_v2 is WS push-only; it never polls)
   ▼
agent_v2 (Python)                    take → progress updates → resolve
   │
   ▼
client polls  POST /api/task/poll/{cap}/{id}   → status, stage, log, output,
                                                  createdAt, typicalRuntimeSeconds
   ▼
OAI backend persists poll snapshot   image_offload_tasks / offload_jobs rows
   ▼
OAI frontend renders from DB + poll  (never talks to MQ directly)
```

## The poll response is the contract

`TaskStatusResponse` ([src/schema.rs](../../../src/schema.rs), camelCase):

| Field | Set by | Notes |
|---|---|---|
| `status` | server | `pending/queued/assigned/starting/running/cancelRequested/…` — `starting`/`running` are ONLY set when the agent sends them in a progress update; otherwise a task sits at `assigned` until resolve |
| `stage` | agent | free-form string (`queued`, `running`, `collecting`, …) — NOT the status |
| `log` | agent | appended progress logs |
| `createdAt` | server | task creation — sandbox anchors its progress ring on this |
| `typicalRuntimeSeconds` | server | `{secs, nanos}` serde Duration; stamped at agent pickup from heuristics; needs **≥2 successful runs** of (base cap, machine) — `MIN_RUNS` in [src/mq/heuristic.rs](../../../src/mq/heuristic.rs) |
| `output` | agent | only when completed/failed |

**Status vs stage is the classic trap.** OAI's image progress bar goes determinate
only when it observes `status ∈ {starting, running}` (that stamps `started_at` in
`image_offload_tasks`); the sandbox `CircularProgress` only needs `createdAt` +
`typicalRuntimeSeconds`. So "works in sandbox, broken in OAI" usually means the
status is stuck at `assigned` while `stage` says `running`.

## Fastest observation points (before starting anything)

1. **OAI ToolDebug modal** — job header → `tool-debug-open` → raw MQ poll JSON.
   This is ground truth for what OAI receives. (Or `POST /api/debug/offload_poll`
   `{cap, id}` with a user JWT.)
2. **Sandbox Dev tab** — every request/response the sandbox apps make.
3. **OAI pipeline events** — job detail timeline; DB `image_pipeline_events`
   (poll noise hidden in UI via `POLL_EVENT_STEPS`).
4. **Direct client poll** (any MQ server you have a client key for):
   ```bash
   curl -s -X POST $MQ/api/task/poll/$CAP/$ID \
     -H 'Content-Type: application/json' -d '{"apiKey":"'$KEY'"}'
   ```
5. **Management API** — `/management/*` with `X-MGMT-API-KEY` for agents/tasks/caps
   (`/management/capabilities/list/online_ext` shows raw caps with brackets).

Local dev keys (documented, do not grep .env): client `client_secret_key_123`,
agent `ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e`,
mgmt `this-is-for-testing-management-tokens`.

## Surface 1 — MQ backend (Rust, src/)

```bash
task test:start     # itests server (:3069) + v1 agent, logs → /tmp/offloadmq-{server,agent}.log
task test:stop      # stop both
task test:logs      # tail both
cargo run           # server only (uses .env)
```

Key code when tracing status/fields:

- Client poll: `do_poll_task_status` in [src/api/client/service.rs](../../../src/api/client/service.rs) → `AssignedTask::into_status_report()` in [src/models.rs](../../../src/models.rs)
- Pickup + heuristic stamp: `take_task` in [src/api/agent/service.rs](../../../src/api/agent/service.rs) (`typical_runtime_seconds = estimate`)
- Progress → status transition: `update_non_urgent_task` in [src/mq/scheduler.rs](../../../src/mq/scheduler.rs) — only `Starting`/`Running` accepted from progress updates, anything else → 400
- WS dispatch (agent frames): `handle_agent_websocket` / `ws_dispatch` in [src/api/agent/mod.rs](../../../src/api/agent/mod.rs) — actions `take`, `update_progress`, `resolve`, `heartbeat`, `info/update`
- Heuristics: [src/mq/heuristic.rs](../../../src/mq/heuristic.rs) (`estimate_duration`, MIN_RUNS=2, per base-cap + machine_id, falls back to global records)

Grep server log for the task id to see submit/pickup/progress lines.

## Surface 2 — agent_v2 (Python)

**Progress data path — where fields get dropped.** A routed executor (imggen,
musicgen, tts, docker…) builds a full `TaskProgressReport` (stage, log, status),
but it does NOT go to the server directly:

```
exec/reporting.py report_progress()          builds report incl. status
  → CaptureTransport.post_task_progress()    transport_exec.py — forwards ONLY (stage, msg) to hook
    → orchestrator progress_reporter()       core/orchestrator.py
      → OffloadMQClient.report_progress()    client.py — REBUILDS the wire report
        → WS frame "update_progress"
```

Anything not threaded through every hop is silently lost (this exact chain once
dropped `status`, leaving tasks stuck at `assigned`; `client.report_progress` now
derives it via `progress_wire_status()` in
[wire.py](../../../agent_v2/agent/src/offloadmq_agent/wire.py) — keep that the
single source of truth). When a poll field looks wrong, diff what the executor
sent against the WS frame the server received.

Run locally against the itests server:

```bash
cd agent_v2 && uv sync
# dev checkouts lack the release-stamped version file:
printf '__version__ = "0.0.0.dev0"\n' > cli-manager/src/cli_manager/_version.py
cp ~/.offloadmq-agent.json /tmp/omq-cfg.bak   # agent rewrites it on shutdown!
uv run omq config set --server http://localhost:3069 \
  --api-key ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e
# shell.* / docker.* are sensitive tier — opt in by adding to
# "sensitive_allowed_caps" in ~/.offloadmq-agent.json before serving
uv run omq register && uv run omq serve      # logs to stdout
# afterwards: restore /tmp/omq-cfg.bak
```

Then drive a task with progress output and watch poll transitions:

```bash
# expect: queued → running (with stage + growing log) → completed
curl -s -X POST localhost:3069/api/task/submit -H 'Content-Type: application/json' \
  -d '{"capability":"shell.bash","urgent":false,"payload":"for i in 1 2 3; do echo t$i; sleep 2; done","apiKey":"client_secret_key_123"}'
```

Type check before committing agent changes (mandatory):
`uv run --with mypy mypy agent/src core/src ui-server/src --ignore-missing-imports`

`offloadmock/` is useless for task-flow debugging — it never executes tasks.

## Surface 3 — OAI (oai/)

OAI backend is a **poll mirror**: it copies MQ poll snapshots into Postgres, and
the frontend renders from those rows. If MQ's poll JSON is right (check ToolDebug
first!) but the UI is wrong, the bug is in persistence or rendering:

- Poll + persist: `poll_and_persist` in [services/image_jobs.rs](../../../oai/backend/src/services/image_jobs.rs) — writes `last_poll_*`, `typical_runtime_seconds`; stamps `started_at` (set-once) on first `starting`/`running` status
- Deserializer: `OffloadPollResponse` in [offload/image_tasks.rs](../../../oai/backend/src/offload/image_tasks.rs) — `typicalRuntimeSeconds` parses serde `{secs,nanos}` into `std::time::Duration`; a field-shape mismatch here fails the whole poll with `ExternalService`
- Drawer list (DB-only, no MQ poll): [services/progress.rs](../../../oai/backend/src/services/progress.rs)
- Frontend bar: `JobProgressBar` — determinate iff status executing AND `started_at` AND `typical_runtime_seconds > 0`; `progressBarMeta` fallback chain in ImageGenerationPage (activePoll → selectedJob → running row)
- Offload-job features (tts/describe/music): same pattern via [services/offload_job.rs](../../../oai/backend/src/services/offload_job.rs) + [offload/task_status.rs](../../../oai/backend/src/offload/task_status.rs)

```bash
cd oai && task infra:up && task dev   # backend :3001 (per oai-img skill; state.rs default may differ), Vite :5174
# MQ URL + client key are runtime admin settings (/app/settings/server), not env
```

Polling cadence: page 5 s (viewed job) · `useRunningImageJobs` 5 s (DB list) ·
`image_pipeline_worker` 20 s (all in-flight jobs). DB rows only refresh when one
of these polls MQ — a "frozen" UI value can just be a dead worker.

OAI submits **base capabilities only** (strip `[brackets]`) — raw caps black-hole
tasks (scheduler matches on base, but the task's cap key must be the base form).

## Deciding which surface owns the bug

| Evidence | Owner |
|---|---|
| ToolDebug/raw poll JSON already wrong (missing/incorrect field) | MQ server or agent |
| Poll JSON has `stage`/`log` moving but `status` stuck at `assigned` | agent not sending status in progress updates (check the CaptureTransport→client hop) |
| `typicalRuntimeSeconds` null | expected until 2 successful runs of that cap on that machine; check heuristics, not a bug per se |
| Poll JSON right, OAI DB row (`image_offload_tasks`) wrong | OAI backend poll/persist |
| DB row right, UI wrong | OAI frontend (check which of the 3 data sources the component actually reads) |
| Task never leaves `queued` | no online agent with matching base cap / tier reservation — check `/management/capabilities/list/online_ext` |
| Sandbox app works, OAI doesn't | almost always status-vs-stage or a field OAI needs that sandbox doesn't (sandbox anchors on `createdAt`) |

## Pitfalls learned the hard way

1. **`stage: "running"` ≠ `status: "running"`** — consumers that key on status
   need the agent to send status explicitly in progress updates.
2. **CaptureTransport hops drop fields** — routed-executor reports are rebuilt
   twice before reaching the wire; verify end-to-end, not at the executor.
3. **Serde `Duration` is `{secs, nanos}`** — JS reads `.secs`; Rust clients must
   deserialize into `std::time::Duration`, not `f64`.
4. **`started_at` in OAI is set-once** (`IS NULL` guard) — a job that never showed
   `running` before completing will never get it; bar stays indeterminate.
5. **Agent rewrites `~/.offloadmq-agent.json` on shutdown** — back it up before
   local experiments, restore after.
6. **v1 itests agent ≠ production agent_v2** — reproduce agent bugs on agent_v2;
   the v1 HTTP-era code paths (`offload-agent/`) differ exactly where it matters
   (reporting/transport).
7. **Heuristic estimate appears only at pickup** — polls before an agent takes
   the task always show `typicalRuntimeSeconds: null`.
