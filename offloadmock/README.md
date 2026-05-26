# OffloadMock

A [FastAPI](https://fastapi.tiangolo.com/) mock of the **OffloadMQ** server. It
reproduces the OffloadMQ HTTP/WebSocket API surface and mirrors the Rust schema
definitions (`src/schema.rs`, `src/models.rs`) **exactly** — same JSON field
names, casing, optionality, defaults, status codes and error envelopes — so
clients and agents can be built and tested without running the real Rust service.

> **No real scheduler — but tasks can be injected.** The queue starts empty;
> the `/testing/*` control surface lets you generate synthetic tasks (or
> issue `slavemode.*` commands) that a real agent can poll, take, progress
> and resolve end-to-end. See [Task behaviour](#task-behaviour) and the
> [Testing surface section in DOCS.md](DOCS.md#testing-surface).

📖 **Full documentation:** [DOCS.md](DOCS.md) — configuration, endpoint reference,
auth model, schema fidelity, agent/client usage, and limitations.

## Quick start

Uses [Go Task](https://taskfile.dev) (`task`):

```bash
cd offloadmock
task install        # create venv + install deps (one-time)
task run            # http://127.0.0.1:3069  (Ctrl-C to stop)

task dev            # autoreload
task run PORT=8000  # override port
task test           # smoke tests
task routes         # list all routes
```

Without Task:

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
PORT=3069 venv/bin/python -m offloadmock.main
```

Interactive docs at `http://localhost:3069/docs`.

### Default credentials

Defaults match the documented local-dev keys (override via env vars):

| Purpose          | Value                                                      | Env var           |
|------------------|-----------------------------------------------------------|-------------------|
| Client API key   | `client_secret_key_123`                                   | `CLIENT_API_KEYS` |
| Agent API key    | `ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e`        | `AGENT_API_KEYS`  |
| Management token  | `this-is-for-testing-management-tokens`                   | `MGMT_TOKEN`      |

Other env vars mirror the Rust server: `JWT_SECRET`, `HOST`, `PORT`,
`DATABASE_ROOT_PATH`, `STORAGE_*`, `APP_VERSION`. `AGENT_API_KEYS` /
`CLIENT_API_KEYS` are **colon-separated** (as in OffloadMQ).

## API surfaces

Four surfaces matching the real server (identical paths and auth to
`src/main.rs`), plus one mock-only control surface:

| Surface         | Prefix            | Auth                                                                 |
|-----------------|-------------------|---------------------------------------------------------------------|
| Client API      | `/api/*`          | `X-API-Key` header **or** `apiKey` JSON body; `X-MGMT-API-KEY` override |
| Storage API     | `/api/storage/*`  | `X-API-Key` header                                                   |
| Agent API       | `/private/agent/*`| `Authorization: Bearer <agent-JWT>` (from `/agent/auth`)            |
| Management API  | `/management/*`   | `Authorization: Bearer <mgmt-token>`                                |
| **Testing API** | `/testing/*`      | `Authorization: Bearer <mgmt-token>` — *mock-only, not on the Rust server* |

Plus public routes: `POST /agent/register`, `POST /agent/auth`,
`GET /health`, `GET /stats`, `GET /version`, and the agent WebSocket
`GET /private/agent/ws?token=<agent-JWT>`.

## Schema fidelity

Implemented in [`schemas.py`](offloadmock/schemas.py) and [`state.py`](offloadmock/state.py):

- **camelCase** for everything under serde `rename_all = "camelCase"`
  (`systemInfo`, `apiKey`, `appVersion`, `uidShort`, `personalLoginToken`, …).
- **Explicit overrides** preserved: `file_bucket` and `output_bucket` stay
  snake_case in `TaskSubmissionRequest`; `timeoutSecs`/`maxWaitSecs`/`runtimeSecs`
  stay camelCase.
- **Snake_case** types kept snake (`FileStatEntry`, `BucketStatResponse`).
- `SystemInfo`/`GpuInfo` accept either `totalMemoryGb`/`vramGb` **or** the legacy
  `totalMemoryMb`/`vramMb` and round MB→GB exactly like the Rust `Deserialize`.
- `TaskStatus` / `CommunicationMethod` serialize with the same variant strings
  (`cancelRequested`, `canceled`, `ws`, …).
- `TaskResultStatus` uses the externally-tagged forms
  (`{"success": f}` / `{"failure": [msg, f]}` / `{"notExecuted": msg}`).
- `DateTime<Utc>` is serialized RFC 3339 with a trailing `Z` (chrono style).
- Required vs optional fields match `#[serde(default)]` presence in Rust.

### Error envelope

Mirrors `AppError` (`src/error.rs`) — same status codes, `type` strings and
`Display`-formatted messages:

```json
{ "error": { "type": "not_found", "message": "Not found: shell.bash[01XYZ]", "status": 404 } }
```

## Task behaviour

There is no real scheduler. The **client** `/api/task/*` surface keeps its
empty-state contract (submits do not persist). Tasks reach the agent only
through the **testing surface**:

- `POST /api/task/submit` (non-urgent) → returns the `queued` envelope with a
  fresh `TaskId` (does not persist).
- `POST /api/task/submit_blocking` and urgent `submit` → replicate the
  precondition: **`503 Scheduling impossible`** when no online agent provides
  the capability; otherwise returns a terminal `failed` body noting
  `OffloadMock does not execute tasks`.
- `POST /api/task/poll/{cap}/{id}` and `POST /api/task/cancel/{cap}/{id}`
  → `404 Not found`.
- `POST /testing/tasks/generate_for_capability` and
  `POST /testing/tasks/issue_slavemode_command` (mgmt-token gated) inject
  tasks that the agent then drives through poll → take → progress → resolve.
- `GET /private/agent/task/poll[_urgent]`, `take`, `resolve`, `progress` are
  wired to the injected queue. With nothing injected they still behave like
  the original empty mock (poll → `null`, take/resolve/progress → 404).
- `GET /management/tasks/list` and `POST /management/tasks/cancel/{cap}/{id}`
  reflect the injected queue.

Agents, client API keys and storage buckets are fully modelled in memory, so
registration, capability reporting, key management and bucket upload/stat/delete
all behave like the real server.

## Tests

```bash
venv/bin/python -m pytest tests -q
```

## Layout

```
offloadmock/
  config.py        # env config (mirrors src/config.rs)
  errors.py        # AppError + JSON envelope (mirrors src/error.rs)
  auth.py          # JWT create/decode (mirrors src/middleware/auth.rs)
  schemas.py       # request/response models (mirrors src/schema.rs)
  state.py         # in-memory agents/keys/buckets (mirrors src/db/*, models.rs)
  deps.py          # auth dependencies (mirrors src/middleware/*)
  responses.py     # chrono-style JSON response
  routers/         # root, agent, client, client_storage, management, ws
  main.py          # app wiring (mirrors src/main.rs route tree)
```
