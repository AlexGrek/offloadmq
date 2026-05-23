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
├── agent/                      ← offloadmq-agent   (lib) async processing toolkit
├── core/                       ← offloadmq-core    (lib) orchestration
├── ui-server/                  ← offloadmq-ui-server (lib) FastAPI + React SPA
├── cli-manager/                ← offloadmq-cli     (TARGET) `omq`
└── gui-manager/                ← offloadmq-gui     (TARGET) `omq-gui`
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

# type-check (mandatory before commit — keep it green)
uv run --with mypy mypy agent/src core/src ui-server/src --ignore-missing-imports

# frontend
cd ui-server/frontend && npm install && npm run build
```

---

## 1. `agent/` — offloadmq-agent (async toolkit)

Pure async processing toolkit. **No orchestration, no settings, no UI.** aiohttp.

| File | Purpose |
|---|---|
| `models.py` | Pydantic v2: `Task`, `TaskResult`, `TaskStatus` (pending/running/completed/failed/cancelled), `LogEntry`, `LogLevel`, `AgentRegistration`, `AgentAuth` |
| `context.py` | `ExecContext` (structured-log sink + cooperative cancel) and `TaskCancelled` |
| `client.py` | `OffloadMQClient` — async aiohttp wrapper (register/authenticate/poll/take/report_progress/resolve) |
| `executor.py` | `Executor` protocol, `@register("prefix")`, `find(capability)`, `registered_prefixes()` |
| `capabilities.py` | `async detect_capabilities()` — probes Ollama + shell, always includes `debug.echo` |
| `exec/debug.py` | `debug.*` — echoes payload (honors `payload.delay`, cancellable) |
| `exec/shell.py` | `shell.*` — subprocess; polls `ctx.cancelled` and kills on cancel |
| `exec/llm.py` | `llm.*` — Ollama streaming; stops on `ctx.cancelled` |

### Executor contract

```python
from offloadmq_agent import register, ExecContext
from offloadmq_agent.models import Task, TaskResult, TaskStatus

@register("mytype")
async def execute_mytype(task: Task, ctx: ExecContext) -> TaskResult:
    await ctx.progress("stage", "human message", key="structured-value")
    ctx.raise_if_cancelled()          # or check `ctx.cancelled`
    return TaskResult(task_id=task.id, status=TaskStatus.COMPLETED, output={...})
```

- Lookup is prefix-based: `"mytype.sub"` matches `@register("mytype")`.
- **Import the module** in `exec/__init__.py` to activate registration.
- Logs are **structured** (`LogEntry`: ts, level, stage, message, data) — never
  print; always go through `ctx.progress/info/warn/error`.
- Cancellation is **cooperative**: long-running executors must poll
  `ctx.cancelled` (subprocess/streaming loops) so the UI cancel button works.
- Never raise out of an executor for expected failures — return
  `TaskResult(status=FAILED, error=...)`. `TaskCancelled` → CANCELLED.

---

## 2. `core/` — offloadmq-core (orchestration)

The single object both entry points drive. Owns settings, the task store, the
threaded executor pool and the polling loop.

| File | Purpose |
|---|---|
| `settings.py` | `Settings` model + `load_settings`/`save_settings`. File: `.offloadmq-agent.json` in CWD. Key field: `max_concurrent` (thread limit, **default 1**) |
| `task_store.py` | `TaskStore` (thread-safe) + `TaskRecord`. In-memory only — **cleared on restart**. Holds active + terminal tasks with full structured logs. Caps terminal history at 200 |
| `executor_pool.py` | `ExecutorPool` — `ThreadPoolExecutor(max_workers=max_concurrent)`; each worker runs `asyncio.run(executor(task, ctx))` |
| `orchestrator.py` | `Orchestrator` — the public API (see below) |
| `webui.py` | `run_blocking()` / `run_in_thread()` / `build_server()` — builds the FastAPI app via `ui_server.create_app(self)` and runs uvicorn |

### Threading model

```
caller thread          orchestrator.start() → spawns:
  poller thread        own asyncio loop: register → auth → poll loop → dispatch
  pool worker × N      asyncio.run(executor) per task   (N = max_concurrent)
  ui-server thread     uvicorn (GUI mode) or blocking (server mode)
```

- The poller only takes a task while `store.active_count() < max_concurrent` —
  the agent never hoards more work than it can run.
- Pool workers report results back to the server by scheduling `client.resolve`
  onto the poller loop via `asyncio.run_coroutine_threadsafe`.
- JWT auto-refreshes 300s before expiry. **No WebSocket** — HTTP polling only.

### Orchestrator public API (also the `OrchestratorAPI` surface)

```python
orch = Orchestrator()                         # loads settings from CWD
orch.get_settings() / update_settings(**f)    # settings (persisted)
orch.scan_capabilities() -> list[str]         # sync wrapper over detect_capabilities
orch.register() -> str                        # register+auth, store creds (standalone)
orch.start() / stop() / is_running()          # lifecycle (start is non-blocking)
orch.status() -> dict                         # running/online/message/agentId/...
orch.list_tasks() -> list[TaskRecord]
orch.get_task(id) -> TaskRecord | None        # includes full logs
orch.cancel_task(id) -> bool                  # sets the cooperative cancel flag
```

---

## 3. `ui-server/` — offloadmq-ui-server (FastAPI + React)

A **library** (no console script). Core drives it. `create_app(orchestrator)`
injects the orchestrator into the routes.

| File | Purpose |
|---|---|
| `protocol.py` | `OrchestratorAPI` Protocol — the contract core must satisfy. Lives here (consumer side) to keep `core → ui_server` one-directional. `list_tasks` returns `Sequence[BaseModel]` (covariant — don't change to `list`) |
| `api.py` | `create_router(orch)` — closure-based `APIRouter(prefix="/api")` |
| `server.py` | `create_app(orch)` — mounts router + serves React `frontend/dist` (SPA fallback via `StaticFiles(html=True)`, `sys._MEIPASS` aware) |

### REST routes (all under `/api`)

| Method | Path | Description |
|---|---|---|
| GET/POST | `/settings` | Get / patch settings (`SettingsPayload`, only non-null fields applied) |
| GET | `/capabilities/detect` | Run capability scan |
| POST | `/agent/start` · `/agent/stop` | Lifecycle (400 if unconfigured) |
| GET | `/agent/status` | Status dict |
| GET | `/tasks` | `{tasks: [...]}` — all records |
| GET | `/tasks/{id}` | One record with full structured logs (404 if missing) |
| POST | `/tasks/{id}/cancel` | Request cancel (404 if not active) |

### React frontend (`ui-server/frontend/`)

Stack: **React 19 · Vite 6 · react-router 7 (library mode) · Tailwind v4 ·
shadcn/ui (new-york) · lucide-react · TypeScript**.

- `@/*` path alias → `src/*` (in `vite.config.ts` + `tsconfig.app.json`).
- Tailwind v4 via `@tailwindcss/vite`; theme in `src/index.css` (`@theme inline`
  + CSS vars, dark by default on `<html class="dark">`). No tailwind.config.js.
- shadcn components in `src/components/ui/` (button, card, badge, input, label,
  tabs, table, dialog, separator). `cn()` in `src/lib/utils.ts`. Add more with
  `npx shadcn@latest add <name>` (`components.json` is configured).
- Routing in `src/App.tsx` with `<Routes>`; `BrowserRouter` in `main.tsx`.
  `src/components/Layout.tsx` is the nav shell (`<Outlet/>`).
- API client: `src/api/client.ts` (typed). Types: `src/types.ts`.
- Polling: `src/hooks/usePoll.ts` (interval fetch). **No WebSocket** — the UI
  polls `/api/tasks` + `/api/agent/status` every ~2s.
- Pages: `DashboardPage` (status + start/stop + counts + active list),
  `TasksPage` (in-progress + history tables, cancel), `TaskDetailPage`
  (structured log rows + output + cancel), `SettingsPage` (form + auto-detect).
- `npm run build` runs `tsc -b && vite build` → `dist/` (served by Python).

---

## 4. `cli-manager/` — offloadmq-cli (TARGET, `omq`)

Typer + Rich. Mirrors the old agent CLI; drives `core.Orchestrator`.

```
omq serve                      Headless poll loop (blocks; Ctrl-C to stop)
omq webui [--start] [-p PORT]  Web dashboard (run_blocking); --start also runs agent
omq register                   Register + store credentials
omq capabilities               Scan and print capabilities
omq status                     Settings/status table
omq config show | set ...      --server --api-key --tier --max-concurrent --autostart
```

`serve`/`webui` honor `settings.autostart`. Entry point: `cli_manager.main:main`.

---

## 5. `gui-manager/` — offloadmq-gui (TARGET, `omq-gui`)

pywebview cross-platform desktop launcher over the same core + ui-server.

```
omq-gui              free-port → run_in_thread(ui-server) → wait → pywebview window
omq-gui --server     run_blocking(ui-server) — headless, open in a browser
omq-gui --port N     override port (auto-falls-back to a free one)
```

- pywebview runs on the **main thread**; the UI server on a daemon thread.
- Honors `settings.autostart` (starts the agent before opening the window).
- Use standard `fetch()` to `/api/*` — identical in window and server modes; do
  NOT use the `window.pywebview.api` bridge (breaks in server mode).

---

## Conventions

### Python
- 3.11+, `from __future__ import annotations`, built-in generics, `pathlib`.
- **mypy strict** is configured on agent/core/ui-server — keep it green.
- All agent I/O is async; never create a module-level `ClientSession`.
- Settings: always `get_settings()` fresh; mutate via `update_settings(**fields)`
  (only non-None fields applied; persisted automatically).
- Threads: daemon only; `threading.Event` for cancel/stop; never let an
  exception escape a pool worker (the pool wraps everything into a `TaskResult`).

### Frontend
- Components are shadcn-style: `data-slot`, `cn()`, cva variants. Match existing.
- Keep the API client typed against `src/types.ts` (mirror Python models).
- Poll for live data; no WebSocket until the backend grows one.

---

## Extension Recipes

### New executor
1. `agent/src/offloadmq_agent/exec/mytype.py` with `@register("mytype")`.
2. Import it in `exec/__init__.py`.
3. Poll `ctx.cancelled` if it can run long; emit structured `ctx.progress`.
4. Add a probe in `capabilities.py` if it needs runtime detection.

### New API route + UI
1. Add a method to `Orchestrator` and to `OrchestratorAPI` (protocol.py).
2. Add the route in `ui_server/api.py` (`create_router`).
3. Add a typed call in `frontend/src/api/client.ts` + types in `types.ts`.
4. Wire UI in a page under `frontend/src/pages/` (+ route in `App.tsx`).

### PyInstaller packaging (per target)
```bash
cd ui-server/frontend && npm run build      # 1. frontend
cd ../../cli-manager                        # or gui-manager
pyinstaller --onefile \
  --add-data "../ui-server/frontend/dist:frontend/dist" \
  src/cli_manager/main.py
```
`server.py` resolves `dist/` from `sys._MEIPASS` at runtime.
```
