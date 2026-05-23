---
name: agent-v2
description: Senior Python engineer context for agent_v2 — the uv-workspace rewrite of offload-agent. Use when working on agent_v2/: the offloadmq-agent toolkit, offloadmq-core orchestrator, ui-server FastAPI backend, React (shadcn) SPA, cli-manager (Typer) or gui-manager (pywebview) entry points.
---

# Agent V2 — Senior Python Engineering

## Project Layout

Root: `agent_v2/` — a **uv workspace** with five subprojects. Two are build
**targets** (entry points with console scripts); three are libraries.

```
agent_v2/
├── pyproject.toml              ← workspace root (no Python code)
├── agent/                      ← offloadmq-agent   (lib) async toolkit + executors
├── core/                       ← offloadmq-core    (lib) orchestration
├── ui-server/                  ← offloadmq-ui-server (lib) FastAPI + React SPA
├── cli-manager/                ← offloadmq-cli     (TARGET) `omq`
├── gui-manager/                ← offloadmq-gui     (TARGET) `omq-gui`
├── tests/                      ← unit tests (cap_policy, etc.)
└── docs/agent-v2-migration.md  ← legacy import + field mapping (repo root)
```

### Dependency graph (acyclic, one-directional)

```
agent  ←  ui-server  ←  core  ←  cli-manager
                          ↑
                          └────  gui-manager
```

- `agent` depends on nothing internal.
- `ui-server` depends on `agent` (for models) and defines the `OrchestratorAPI`
  Protocol it needs — it never imports `core`.
- `core` depends on `agent` + `ui-server`; its `Orchestrator` satisfies
  `OrchestratorAPI` structurally and launches the UI server.
- `cli-manager` and `gui-manager` depend only on `core`.

All cross-package deps use `[tool.uv.sources] pkg = { workspace = true }`.

### Workspace commands

```bash
cd agent_v2
uv sync                                    # resolve + install everything
uv run omq serve                           # CLI: headless agent
uv run omq webui --start                   # CLI: web dashboard + agent
uv run omq-gui                             # GUI: native window
uv run omq-gui --server                    # GUI: headless server mode
uv run omq config import-legacy            # import ~/.offload-agent.json → v2

# type-check (mandatory before commit — keep it green)
uv run --with mypy mypy agent/src core/src ui-server/src --ignore-missing-imports

# tests
uv run --with pytest pytest tests/ -q

# frontend
cd ui-server/frontend && npm install && npm run build
```

---

## 1. `agent/` — offloadmq-agent (toolkit + executors)

Processing toolkit used by core. **No orchestration, no UI.** Poll/register via
aiohttp; routed executors use sync `requests` inside worker threads.

### Core modules

| File | Purpose |
|---|---|
| `models.py` | `Task` (includes `server_task` from poll), `TaskResult`, `TaskStatus`, `LogEntry`, registration DTOs |
| `wire.py` | Server wire types: `TaskId`, `TaskResultReport`, `TaskProgressReport` |
| `context.py` | `ExecContext` — structured logs, cooperative cancel, `agent_transport` |
| `client.py` | `OffloadMQClient` — register/auth, poll (urgent + normal), take, progress, **wire-format resolve** |
| `executor.py` | `@register("prefix")`, `find()`, `registered_prefixes()` |
| `capabilities.py` | Async wrapper over `capabilities_sync.detect_capabilities()` |
| `capabilities_sync.py` | Full runtime probes (Ollama, docker, ComfyUI, custom, ONNX, …) |
| `cap_policy.py` | 3-tier policy: `compute_registration_caps()`, `classify_capabilities()` |
| `slavemode_policy.py` | Slavemode allow-list merge |
| `pipeline.py` | Full task pipeline: bucket download, data prep, routed executor, capture result |
| `transport_sync.py` | `SyncAgentTransport` — sync HTTP for executors (buckets, resolve wire) |
| `transport_exec.py` | `CaptureTransport` — forwards I/O, captures `TaskResultReport`, maps progress to ctx |
| `result_convert.py` | `TaskResult` ↔ wire report conversion |
| `rescan.py` | `rescan_and_push()` for slavemode |
| `settings_util.py` | Read `.offloadmq-agent.json` from CWD (no core import) |
| `custom_caps.py`, `onnx_models.py`, `ollama.py` | Supporting runtime for custom/onnx/llm detection |
| `systeminfo.py`, `tier.py` | Hardware info + auto-tier |

### Executors

**Native async** (return `TaskResult` directly; preferred for new work):

| Prefix | Module |
|---|---|
| `debug` | `exec/debug.py` |
| `shell` | `exec/shell.py` |
| `llm` | `exec/llm.py` |

**Routed pipeline** (sync legacy-style handlers on worker thread via `exec/routed.py`):

| Prefix | Module(s) |
|---|---|
| `docker` | `exec/docker.py` |
| `imggen` | `exec/imggen/` |
| `txt2music` | `exec/musicgen/` |
| `onnx` | `exec/onnx.py` |
| `custom` | `exec/custom.py` |
| `slavemode` | `exec/slavemode.py` |
| `tts` | `exec/tts.py` (`tts.kokoro`) |
| `shellcmd` | `exec/shellcmd.py` (`shellcmd.bash`) |

Registration: `exec/__init__.py` imports native modules + calls `register_routed_executors()`.
Routing table: `exec/route.py`. Shared reporting: `exec/reporting.py`.

### Executor contract (native async)

```python
from offloadmq_agent import register, ExecContext
from offloadmq_agent.models import Task, TaskResult, TaskStatus

@register("mytype")
async def execute_mytype(task: Task, ctx: ExecContext) -> TaskResult:
    await ctx.progress("stage", "human message", key="structured-value")
    ctx.raise_if_cancelled()
    return TaskResult(task_id=task.id, status=TaskStatus.COMPLETED, output={...})
```

- Prefix lookup: `"mytype.sub"` matches `@register("mytype")`.
- **Never** `print` for task output — use `ctx.progress/info/warn/error`.
- Cooperative cancel: poll `ctx.cancelled` in long loops.
- Expected failures → `TaskResult(status=FAILED, error=...)`. `TaskCancelled` → CANCELLED.

### Routed executor contract (ported sync)

Legacy-shaped handlers:

```python
def execute_foo(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict,
    data: Path,
    job_timeout: int = 600,
    output_bucket: str | None = None,  # imggen/txt2music only
) -> bool: ...
```

`pipeline.run_routed_task()` wraps them: builds `CaptureTransport`, runs downloads/data prep,
converts captured `TaskResultReport` → `TaskResult`. Orchestrator resolves via wire format.

### Capability tiers (registration policy)

| Tier | Config key | Model |
|---|---|---|
| Regular (opt-out) | `regular_disabled_caps` | Enabled if detected unless listed |
| Sensitive (opt-in) | `sensitive_allowed_caps` | `docker.*`, `shell.*`, `shellcmd.*` |
| Slavemode (opt-in) | `slavemode_allowed_caps` | `slavemode.*` control caps |

`compute_registration_caps(cfg, detected)` in `cap_policy.py` applies policy + merges slavemode.

---

## 2. `core/` — offloadmq-core (orchestration)

Single object both entry points drive. Settings, task store, executor pool, poller.

| File | Purpose |
|---|---|
| `settings.py` | `Settings` in `.offloadmq-agent.json` — server, api_key, display_name, tier policy, comfy URL, OS flags, webui_port, credentials |
| `legacy_migration.py` | Map `~/.offload-agent.json` → v2 settings |
| `task_store.py` | In-memory tasks + logs; terminal cap 200 |
| `executor_pool.py` | `ThreadPoolExecutor`; `asyncio.run(executor)` per task |
| `orchestrator.py` | Lifecycle, urgent+normal poll, progress forward, cap push, background rescan |
| `agent_log.py` | Ring buffer for UI log tail |
| `scan_state.py` | Background scan state for capabilities UI |
| `webui.py` | uvicorn lifecycle |
| `custom_caps_service.py`, `comfy_service.py`, `updater.py`, `startup_win/mac.py`, `systemd_service.py` | UI-backed ops |

### Threading model

```
caller thread          orchestrator.start() → spawns:
  poller thread        asyncio loop: register → auth → poll (urgent first) → dispatch
  pool worker × N      asyncio.run(executor) per task
  rescan thread        stepped capability rescan + push
  ui-server thread     uvicorn (GUI) or blocking (server mode)
```

- Poller respects `max_concurrent`; passes `SyncAgentTransport` as `ctx.agent_transport`.
- `client.resolve` uses wire `TaskResultReport` shape via `result_convert`.
- JWT refresh 300s before expiry. **HTTP polling only** (no WebSocket transport).

### Orchestrator API (implements `OrchestratorAPI`)

```python
orch.get_settings() / update_settings(**fields)
orch.get_raw_settings_json() / save_raw_settings_json(text)
orch.scan_capabilities() / get_scan_state() / start_background_scan()
orch.rescan(restart_if_changed=False) / update_capability_policy(...)
orch.register() / start() / stop() / status() / get_agent_logs(n)
orch.list_tasks() / get_task(id) / cancel_task(id)
```

---

## 3. `ui-server/` — FastAPI + React

Library only. `create_app(orchestrator)` injects orchestrator into routes.

| File | Purpose |
|---|---|
| `protocol.py` | `OrchestratorAPI` Protocol |
| `api.py` | All `/api/*` routes (see below) |
| `server.py` | SPA mount + startup autostart/background scan |

### REST routes (under `/api`)

**Core:** `/settings`, `/config/raw`, `/capabilities/detect`, `/capabilities/state`,
`/capabilities/rescan`, `/capabilities/policy`, `/agent/start|stop|status|logs|register`,
`/tasks`, `/tasks/{id}`, `/tasks/{id}/cancel`

**Parity:** `/custom/*`, `/comfy/*`, `/system/info`, `/system/win-startup`, `/system/mac-startup`,
`/system/install-systemd`, `/update/check`, `/update/download`

### React frontend

Stack: React 19 · Vite 6 · react-router 7 · Tailwind v4 · shadcn/ui · TypeScript.

**Routes** (`App.tsx` + `Layout.tsx`):

| Path | Page |
|---|---|
| `/` | Dashboard |
| `/tasks`, `/tasks/:id` | Tasks + detail (payload, structured logs, cancel) |
| `/connection` | Server, API key, display name |
| `/capabilities` | Tiered caps + rescan/restart |
| `/slavemode` | Slavemode allow-list |
| `/custom` | Custom cap YAML editor |
| `/comfy` | ComfyUI URL + workflow list |
| `/system` | Sysinfo, updater, webui port, OS startup |
| `/logs` | Global agent log tail |
| `/config` | Raw JSON editor |
| `/settings` | Quick settings form |

Poll via `usePoll.ts` (~1.5–2s). API client: `src/api/client.ts`, types: `src/types.ts`.

---

## 4. `cli-manager/` — `omq`

```
omq serve
omq webui [--start] [-p PORT]
omq register
omq capabilities
omq status
omq config show | set ...
omq config import-legacy [--from PATH] [--merge/--replace]
```

---

## 5. `gui-manager/` — `omq-gui`

```
omq-gui              pywebview + daemon ui-server
omq-gui --server     blocking uvicorn
omq-gui --port N
```

Use `fetch('/api/*')` only — not `window.pywebview.api`.

---

## Conventions

### Python
- 3.11+, `from __future__ import annotations`.
- **mypy strict** on agent/core/ui-server — keep green.
- No module-level `aiohttp.ClientSession` in agent.
- Settings: mutate via `orch.update_settings(**fields)` (core owns persistence).
- Daemon threads only; pool workers must not leak exceptions.

### Frontend
- shadcn patterns: `data-slot`, `cn()`, cva.
- Typed API client; poll for live data.

### Legacy offload-agent
- v2 is **self-contained** — do not require `offload-agent/` on `PYTHONPATH`.
- Ported code lives under `offloadmq_agent/exec/` and related agent modules.
- Field mapping: see `docs/agent-v2-migration.md`.

---

## Extension Recipes

### New native async executor
1. `exec/mytype.py` with `@register("mytype")`.
2. Import in `exec/__init__.py` (before routed registration if prefix could overlap).
3. Add probe in `capabilities_sync.py` if runtime-detected.
4. Policy: regular vs sensitive in `cap_policy.py` if needed.

### New routed (sync) executor
1. Add handler in `exec/mytype.py` (legacy signature + `reporting` helpers).
2. Register route in `exec/route.py`.
3. Add prefix to `register_routed_executors()` in `exec/routed.py`.

### New API route + UI
1. Method on `Orchestrator` + `OrchestratorAPI`.
2. Route in `ui_server/api.py`.
3. `frontend/src/api/client.ts` + `types.ts` + page + `App.tsx` route.

### PyInstaller packaging
```bash
cd ui-server/frontend && npm run build
cd ../../cli-manager   # or gui-manager
pyinstaller --onefile \
  --add-data "../ui-server/frontend/dist:frontend/dist" \
  src/cli_manager/main.py
```
`server.py` resolves `dist/` from `sys._MEIPASS` at runtime.
