# OffloadMock — Complete Documentation

OffloadMock is a [FastAPI](https://fastapi.tiangolo.com/) mock of the **OffloadMQ**
Rust server. It reproduces the OffloadMQ HTTP/WebSocket API surface and mirrors
the Rust schema definitions ([`src/schema.rs`](../src/schema.rs),
[`src/models.rs`](../src/models.rs), [`src/error.rs`](../src/error.rs)) **exactly**
— same JSON field names, casing, optionality, defaults, status codes and error
envelopes — so clients and agents can be developed and tested without running the
real Rust service, Sled DB, or any real compute.

- **Source:** [`offloadmock/`](.) (this directory)
- **Mirrors route tree:** [`src/main.rs`](../src/main.rs)
- **Verified against:** the real V2 agent (`agent_v2`, `omq` CLI) — see
  [Using with the V2 agent](#using-with-the-v2-agent).

> **TL;DR:** Agents, client API keys, and storage buckets behave like the real
> server. There is **no task execution** — but the queue starts empty and can
> be populated on demand via the [Testing surface](#testing-surface), which lets
> a real agent drive the full poll → take → progress → resolve lifecycle
> against the mock. See [What it can / cannot do](#what-it-can--cannot-do).

---

## Contents

1. [Quick start](#quick-start)
2. [Configuration](#configuration)
3. [Authentication model](#authentication-model)
4. [What it can / cannot do](#what-it-can--cannot-do)
5. [Endpoint reference](#endpoint-reference)
6. [Schema fidelity](#schema-fidelity)
7. [Error model](#error-model)
8. [Using with the V2 agent](#using-with-the-v2-agent)
9. [Using as a client](#using-as-a-client)
10. [Storage bucket workflow](#storage-bucket-workflow)
11. [WebSocket](#websocket)
12. [Testing surface](#testing-surface)
13. [Testing](#testing)
14. [Troubleshooting](#troubleshooting)
15. [Keeping in sync with the Rust server](#keeping-in-sync-with-the-rust-server)

---

## Quick start

Uses [Go Task](https://taskfile.dev) (`task`). Install it with `brew install go-task`
(macOS) or see the [install docs](https://taskfile.dev/installation/).

```bash
cd offloadmock

task install        # create venv + install deps (one-time)
task run            # run on http://127.0.0.1:3069  (Ctrl-C to stop)

# variants
task dev            # autoreload (uvicorn --reload)
task run PORT=8000 HOST=0.0.0.0   # override bind address
task test           # run the smoke tests
task health         # curl /health on a running server
task routes         # print every route the server exposes
task clean          # remove venv + caches
```

Interactive API docs (Swagger UI) at `http://127.0.0.1:3069/docs`.

### Without Task (manual)

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
PORT=3069 HOST=127.0.0.1 venv/bin/python -m offloadmock.main
# …or with autoreload:
venv/bin/uvicorn offloadmock.main:app --reload --port 3069
```

---

## Configuration

All configuration is via environment variables, mirroring
[`src/config.rs`](../src/config.rs). Defaults match the documented local-dev
values (see [CLAUDE.md](../CLAUDE.md)) so the mock works out of the box.

| Variable | Default | Notes |
|----------|---------|-------|
| `HOST` | `0.0.0.0` (`127.0.0.1` via Taskfile) | Bind host |
| `PORT` | `3069` | Bind port (same as OffloadMQ) |
| `CLIENT_API_KEYS` | `client_secret_key_123` | **Colon**-separated; predefined wildcard (`*`) keys |
| `AGENT_API_KEYS` | `ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e` | **Colon**-separated; accepted at `/agent/register` |
| `MGMT_TOKEN` | `this-is-for-testing-management-tokens` | Bearer token for `/management/*` and `X-MGMT-API-KEY` |
| `JWT_SECRET` | `your-super-secret-and-long-jwt-key` | HS256 secret for agent JWTs |
| `APP_VERSION` | `unknown` | Returned by `/version` |
| `DATABASE_ROOT_PATH` | `./data` | Only used to derive the storage root default |
| `STORAGE_MAX_BUCKETS_PER_KEY` | `256` | Bucket quota per client key |
| `STORAGE_BUCKET_SIZE_BYTES` | `1073741824` (1 GiB) | Max bytes per bucket |
| `STORAGE_BUCKET_TTL_MINUTES` | `1440` (24 h) | Bucket lifetime |
| `STORAGE_BACKEND` | `local` | Accepted for parity; files are kept in memory |

> ⚠️ `CLIENT_API_KEYS` / `AGENT_API_KEYS` are **colon-separated**, matching the
> Rust server (`split(':')`), not comma-separated.

### Local-dev credentials (defaults)

| Purpose | Value |
|---------|-------|
| Client API key | `client_secret_key_123` |
| Agent API key | `ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e` |
| Management token | `this-is-for-testing-management-tokens` |

---

## Authentication model

Four API surfaces, each with the same auth scheme and path prefix as
[`src/main.rs`](../src/main.rs):

| Surface | Prefix | Auth |
|---------|--------|------|
| **Client API** | `/api/*` | `X-API-Key: <client-key>` header **or** `apiKey` field in the JSON body. `X-MGMT-API-KEY: <mgmt-token>` header overrides client-key + capability checks. |
| **Storage API** | `/api/storage/*` | `X-API-Key: <client-key>` header only |
| **Agent API** | `/private/agent/*` | `Authorization: Bearer <agent-JWT>` (obtained from `/agent/auth`) |
| **Management API** | `/management/*` | `Authorization: Bearer <mgmt-token>` |

Public (no auth): `/health`, `/stats`, `/version`, `POST /agent/register`,
`POST /agent/auth`, and the WebSocket `GET /private/agent/ws?token=<agent-JWT>`.

The agent JWT lifecycle: register (`/agent/register`) → receive
`{agentId, key}` → exchange for a JWT at `/agent/auth` → use
`Authorization: Bearer <token>` for all `/private/agent/*` calls. Tokens are
HS256, valid one week; `expiresIn` is the **absolute** expiry unix timestamp
(matching the Rust server).

---

## What it can / cannot do

### ✅ Can do (full behaviour)

- **Agent registration & lifecycle** — register, authenticate (JWT), `ping`,
  `info/update`. Stored in memory; agents go "online"/"offline" on a 120 s
  `lastContact` window, exactly like the server.
- **Capability reporting** — `/api/capabilities/online` (base caps),
  `/api/capabilities/list/online_ext` (raw caps with `[brackets]`), and the
  management equivalents. Extended-attribute stripping matches the server.
- **Client API key management** — list, create, revoke (management API).
  Capability wildcards (`*`, `prefix*`) are honoured in `verify_key`.
- **Storage buckets** — create, list, stat, upload (multipart), download,
  per-file hash, delete file, delete bucket. Quotas, SHA-256 digests, ownership
  checks and `remaining_bytes` math all behave like the server. File bytes are
  kept in memory.
- **Exact schemas & errors** — every response matches the Rust JSON shape
  (camelCase, `Z` datetimes, error envelope). See [Schema fidelity](#schema-fidelity).
- **WebSocket** — agent WS connect, welcome frame, 5 s heartbeats, and the
  request/response envelope for the dispatched actions.

- **Inject synthetic tasks** via the [Testing surface](#testing-surface) so a
  real agent can poll → take → progress → resolve them end-to-end. The mock
  matches by base capability (extended attributes stripped), supports
  per-agent targeting, and treats the urgent vs regular queues separately.

### ❌ Cannot do (by design — "no real scheduler")

- **Execute work.** There is still no executor — the agent does the actual
  running. The mock only stores task state and observes the lifecycle.
- **Schedule client submissions.** `POST /api/task/submit` does *not* persist
  the task into the queue; only the `/testing/*` surface injects pollable
  tasks. (This keeps the empty-state contract for non-testing clients.)
- **Persist anything.** All state (agents, keys, buckets, files) is in memory and
  lost on restart. No Sled DB, no filesystem/S3/WebDAV storage backends.
- **Block on urgent tasks.** `submit_blocking` does not wait for a result
  (nothing executes) — see the task-endpoint behaviour below.
- **Heuristics / service logs.** Those endpoints exist and return well-formed
  **empty** results (no data is ever recorded).
- **Background workers.** No stale-agent cleanup loop, no bucket-expiry loop, no
  task-timeout loop (the manual `/management/.../cleanup/trigger` endpoints still
  work on demand).
- **Real auth crypto parity.** JWTs are real HS256, but there is no bcrypt, no
  revocation archive tree, etc. — just enough to be indistinguishable to clients.

### Task-endpoint behaviour

The client `/api/task/*` surface keeps its empty-state contract — it never
populates the queue. The `/private/agent/task/*` surface serves whatever has
been injected via `/testing/*`; with nothing injected it behaves exactly like
the original empty mock.

| Endpoint | Behaviour |
|----------|-----------|
| `POST /api/task/submit` (non-urgent) | Returns the `queued` envelope with a fresh `TaskId` (does **not** persist) |
| `POST /api/task/submit` (urgent) / `POST /api/task/submit_blocking` | `503 Scheduling impossible` if **no online agent** provides the capability; otherwise returns a terminal `{"id": …, "status": "failed", "message": "OffloadMock does not execute tasks"}` |
| `POST /api/task/poll/{cap}/{id}` | `404 Not found` |
| `POST /api/task/cancel/{cap}/{id}` | `404 Not found` |
| Agent `poll` / `poll_urgent` | First injected task matching the agent's caps, or `null` |
| Agent `take` / `resolve` / `progress` | Serves injected tasks; `404` if unknown |
| `GET /management/tasks/list` | Reflects injected tasks split by urgent/regular × assigned/unassigned |
| `POST /management/tasks/cancel/{cap}/{id}` | Marks an injected task `cancelRequested`; `404` if unknown |

---

## Endpoint reference

`task routes` prints the live list. Grouped by surface:

### Public

| Method | Path | Response |
|--------|------|----------|
| GET | `/health` | `{status, agents, timestamp}` |
| GET | `/stats` | `{agents, storage_paths}` |
| GET | `/version` | `{version}` |
| POST | `/agent/register` | `{agentId, key, message}` |
| POST | `/agent/auth` | `{token, expiresIn}` |
| WS | `/private/agent/ws?token=<jwt>` | welcome + heartbeats + dispatch |

### Agent API — `/private/agent/*` (Bearer agent JWT)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/ping` | `{status: "ok"}`; refreshes `lastContact` |
| POST | `/info/update` | body `AgentUpdateRequest` → `{agentId, key, message}` |
| GET | `/task/poll` | `UnassignedTask`-shaped body (checks urgent first), else `null` |
| GET | `/task/poll_urgent` | `UnassignedTask` from the urgent queue, else `null` |
| POST | `/take/{cap}/{id}` | `AssignedTask`-shaped body; `404` if not pollable / already taken |
| POST | `/task/resolve/{cap}/{id}` | body `TaskResultReport` → `{"message": "task report confirmed"}`; `404` if unknown |
| POST | `/task/progress/{cap}/{id}` | body `TaskUpdate` → `{"message": "task update confirmed"}`; `404` if unknown |
| GET | `/bucket/{bucket_uid}/stat` | `BucketStatResponse` |
| GET | `/bucket/{bucket_uid}/file/{file_uid}` | raw bytes |
| POST | `/bucket/{bucket_uid}/upload` | multipart `file` → `{file_uid, original_name, size, sha256}` |

### Client API — `/api/*` (client key / mgmt override)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/ping` | health, but behind client auth |
| POST | `/task/submit` | body `TaskSubmissionRequest` |
| POST | `/task/submit_blocking` | urgent only; else `400` |
| POST | `/task/poll/{cap}/{id}` | body `{apiKey}`; `404` |
| POST | `/task/cancel/{cap}/{id}` | body `{apiKey}`; `404` |
| POST | `/capabilities/online` | body `{apiKey}` → base caps (filtered by key) |
| POST | `/capabilities/list/online_ext` | body `{apiKey}` → raw caps (filtered by key) |

### Storage API — `/api/storage/*` (`X-API-Key`)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/limits` | quota config |
| GET | `/buckets` | `{buckets: [...]}` for this key |
| POST | `/bucket/create` | `?rm_after_task=` → `201 {bucket_uid, created_at, rm_after_task}` |
| POST | `/bucket/{uid}/upload` | multipart `file` → `201 {...}` |
| GET | `/bucket/{uid}/stat` | files + `remaining_bytes` |
| GET | `/bucket/{uid}/file/{file_uid}/hash` | `{file_uid, sha256}` |
| GET | `/bucket/{uid}/file/{file_uid}` | raw bytes |
| DELETE | `/bucket/{uid}/file/{file_uid}` | `{deleted_file_uid}` |
| DELETE | `/bucket/{uid}` | `{deleted_bucket_uid}` |

### Management API — `/management/*` (Bearer mgmt token)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/version` | `{version}` |
| GET | `/capabilities/list/online` | base caps (all online agents) |
| GET | `/capabilities/list/online_ext` | raw caps |
| GET | `/tasks/list` | injected tasks split `urgent`/`regular` × `assigned`/`unassigned` |
| POST | `/tasks/reset` | `{result}` (clears the injected queue) |
| POST | `/tasks/cancel/{cap}/{id}` | marks `cancelRequested` (then `canceled` on agent ack), else `404` |
| GET | `/agents/list` | `[Agent]` |
| GET | `/agents/list/online` | `[Agent]` (online only) |
| POST | `/agents/reset` | clears all agents |
| POST | `/agents/delete/{agent_id}` | `"Agent deleted"` |
| POST | `/agents/cleanup/trigger` | `{deleted, ttl_days}` |
| GET | `/client_api_keys/list` | `[ClientApiKey]` |
| POST | `/client_api_keys/update` | body `CreateApiKeyRequest` → `ClientApiKey` |
| POST | `/client_api_keys/revoke/{id}` | `ClientApiKey` (revoked) or `404` |
| GET | `/service_logs?class=…` | empty page |
| GET | `/heuristics/records` | empty page |
| GET | `/heuristics/stats/runners` | empty |
| GET | `/heuristics/stats/machines` | empty |
| GET | `/heuristics/estimate_duration` | `{…, estimatedMs: null}` |
| POST | `/heuristics/cleanup/trigger` | counts (0) |
| GET | `/storage/buckets` | grouped by key |
| DELETE | `/storage/buckets` | purge all |
| GET | `/storage/quotas` | `?api_key=` optional |
| DELETE | `/storage/bucket/{uid}` | delete one |
| DELETE | `/storage/key/{api_key}/buckets` | delete a key's buckets |
| POST | `/storage/cleanup/trigger` | purge expired |

---

## Schema fidelity

Implemented in [`offloadmock/schemas.py`](offloadmock/schemas.py) and
[`offloadmock/state.py`](offloadmock/state.py):

- **camelCase** for everything under serde `rename_all = "camelCase"`
  (`systemInfo`, `apiKey`, `appVersion`, `uidShort`, `personalLoginToken`, …).
- **Explicit serde overrides preserved:** `file_bucket` and `output_bucket` stay
  snake_case in `TaskSubmissionRequest`; `timeoutSecs` / `maxWaitSecs` /
  `runtimeSecs` stay camelCase. Snake-cased types (`FileStatEntry`,
  `BucketStatResponse`) stay snake.
- **MB→GB coercion:** `SystemInfo` / `GpuInfo` accept either `totalMemoryGb` /
  `vramGb` **or** the legacy `totalMemoryMb` / `vramMb` and round MB→GB exactly
  like the Rust custom `Deserialize`.
- **Enum strings:** `TaskStatus` (`cancelRequested`, `canceled`, …),
  `CommunicationMethod` (`http` / `ws`).
- **`TaskResultStatus`** uses the externally-tagged forms:
  `{"success": f}` / `{"failure": [msg, f]}` / `{"notExecuted": msg}`.
- **Datetimes:** `DateTime<Utc>` serialized RFC 3339 with a trailing `Z` (chrono
  style), not `+00:00`.
- **Required vs optional** mirrors `#[serde(default)]` presence in Rust.

---

## Error model

Mirrors `AppError` ([`src/error.rs`](../src/error.rs)) — identical status codes,
`type` strings and `Display`-formatted messages:

```json
{ "error": { "type": "not_found", "message": "Not found: shell.bash[01XYZ]", "status": 404 } }
```

| Error | Status | `type` |
|-------|--------|--------|
| Authentication | 401 | `authentication_error` |
| Authorization | 403 | `authorization_error` |
| BadRequest / Validation / Parse | 400 | `bad_request` / `validation_error` / `parse_error` |
| NotFound | 404 | `not_found` |
| Conflict | 409 | `conflict` |
| ClientClosedRequest | 499 | `client_closed_request` |
| SchedulingImpossible | 503 | `scheduling impossible` |
| Internal / Database / … | 500 | `internal_error` / … |

---

## Using with the V2 agent

The real `omq` CLI (`agent_v2`) treats the mock as a real server. Verified flow:
register → auth → `info/update` → `poll_urgent` + `poll` loop, all `200`.

```bash
# 1. Start the mock
cd offloadmock && task run            # http://127.0.0.1:3069

# 2. Point the agent at it (in another shell, from agent_v2/)
cd agent_v2
uv run omq config set \
  --server http://127.0.0.1:3069 \
  --api-key ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e
uv run omq register      # → "Registered as 01K…"
uv run omq status
uv run omq serve         # registers, auths, and polls the mock continuously
```

> ⚠️ **Config caveat:** the agent stores settings in `~/.offloadmq-agent.json`
> and **rewrites it on shutdown**. Before testing, back it up
> (`cp ~/.offloadmq-agent.json /tmp/agent.bak`) and restore it **after** stopping
> the agent (the shutdown save will clobber an earlier restore). Or run the agent
> with a throwaway `HOME`.

The agent will poll forever and receive `200 null` (no tasks). To see it react to
a "real" server you can submit a task as a client (returns `queued`), but the
mock will never hand it to the agent.

---

## Using as a client

```bash
SRV=http://127.0.0.1:3069
CK=client_secret_key_123
MGMT=this-is-for-testing-management-tokens

# Health
curl -s $SRV/health

# Submit a non-urgent task (returns queued shape; not persisted)
curl -s -X POST $SRV/api/task/submit \
  -H 'Content-Type: application/json' \
  -d '{"capability":"shell.bash","payload":{"cmd":"echo hi"},"apiKey":"'$CK'"}'

# Online capabilities (reflects registered agents)
curl -s -X POST $SRV/api/capabilities/online \
  -H 'Content-Type: application/json' -d '{"apiKey":"'$CK'"}'

# Management: list agents
curl -s $SRV/management/agents/list -H "Authorization: Bearer $MGMT"
```

Header auth works too: `-H "X-API-Key: $CK"` instead of the `apiKey` body field.

---

## Storage bucket workflow

```bash
SRV=http://127.0.0.1:3069
CK=client_secret_key_123

# Create a bucket
UID=$(curl -s -X POST $SRV/api/storage/bucket/create -H "X-API-Key: $CK" | python3 -c 'import sys,json;print(json.load(sys.stdin)["bucket_uid"])')

# Upload a file (multipart field name MUST be "file")
echo "hello" > /tmp/hello.txt
curl -s -X POST $SRV/api/storage/bucket/$UID/upload -H "X-API-Key: $CK" -F "file=@/tmp/hello.txt"

# Inspect / hash / download
curl -s $SRV/api/storage/bucket/$UID/stat -H "X-API-Key: $CK"
curl -s -X DELETE $SRV/api/storage/bucket/$UID -H "X-API-Key: $CK"
```

Agents read buckets via `/private/agent/bucket/{uid}/stat` and
`/private/agent/bucket/{uid}/file/{file_uid}` (any valid agent JWT can access any
bucket — the UID acts as a capability token, same as the server).

---

## WebSocket

```
GET /private/agent/ws?token=<agent-JWT>
```

On connect the server sends
`{"type":"connected","agent_id":"<short>","message":"…"}`, then a
`{"type":"heartbeat","counter":N,"timestamp":"…Z"}` every 5 s. Requests use the
envelope `{"req_id","action","params"}`; responses are
`{"req_id","type":"response","status","data"}` or
`{"req_id","type":"error","status","error":{type,message}}`. `poll_task` /
`poll_task_urgent` return `data: null`; task mutations return not-found errors.

---

## Testing surface

`/testing/*` is an OffloadMock-specific control plane (not present on the real
Rust server) for injecting tasks the queue would otherwise be empty of. It is
gated by the same `Authorization: Bearer <mgmt-token>` as `/management/*`, and
every task it creates is pollable by the matching agent immediately.

### Endpoints

| Method | Path | Notes |
|--------|------|-------|
| POST | `/testing/tasks/generate_for_capability` | Inject `count` synthetic tasks for `capability` |
| POST | `/testing/tasks/issue_slavemode_command` | Inject a single `slavemode.*` task |
| GET | `/testing/tasks/list` | Compact view of every injected task (`{count, tasks}`) |
| GET | `/testing/tasks/{cap}/{id}` | One task with `status`, `result`, `log`, `history` |
| POST | `/testing/tasks/reset` | Drop every injected task → `{deleted}` |
| GET | `/testing/templates` | Sample known capabilities + the slavemode catalog |

### `POST /testing/tasks/generate_for_capability`

Generates one or more tasks. Payloads come from a per-capability template (see
[`offloadmock/task_templates.py`](offloadmock/task_templates.py)) unless you
override them. Templated capabilities include `debug.echo`, `shell.bash`,
`shellcmd.bash`, `llm.*`, `imggen.*`, `txt2music.*`, `tts.kokoro`; any other
capability falls back to a generic `{input, nonce}` payload.

Request body (`GenerateTasksRequest`):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `capability` | string | — | Required. Base or extended (`llm.qwen3:8b[vision]`); matching uses the base. |
| `count` | int | `1` | 1–1000 |
| `urgent` | bool | `false` | If true, only `poll_urgent` returns it |
| `restartable` | bool | `false` | Pass-through to the synthetic `TaskSubmissionRequest` |
| `randomize` | bool | `true` | Re-rolls the template payload per task |
| `payload` | any | `null` | Override; replaces the template payload verbatim |
| `apiKey` | string | first `CLIENT_API_KEYS` | Stamped onto the synthetic submission |
| `targetAgentId` | string | `null` | Restrict polling to this agent (404 if unknown) |
| `timeoutSecs` / `maxWaitSecs` / `runtimeSecs` | int | `null` | Pass-through |
| `file_bucket` / `output_bucket` | list[str] / str | `[]` / `null` | Pass-through (no validation) |

Response: `{capability, count, urgent, targetAgentId, hasOnlineAgent, tasks: [{id, capability, urgent, payload}]}`.

```bash
curl -s -X POST http://127.0.0.1:3069/testing/tasks/generate_for_capability \
  -H "Authorization: Bearer this-is-for-testing-management-tokens" \
  -H "Content-Type: application/json" \
  -d '{"capability": "debug.echo", "count": 3}'
```

### `POST /testing/tasks/issue_slavemode_command`

Convenience for the `slavemode.*` catalog. Accepts either a bare suffix
(`force-rescan`) or the fully-qualified cap (`slavemode.force-rescan`); a
non-slavemode cap like `debug.echo` is rejected with `400`.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `command` | string | — | Required |
| `payload` | any | catalog default (see below) | Override |
| `targetAgentId` | string | `null` | Restrict to one agent |
| `urgent` | bool | `false` | |
| `apiKey` | string | first `CLIENT_API_KEYS` | |

Default payloads from the catalog:

| Command | Default payload |
|---------|-----------------|
| `slavemode.force-rescan` | `{}` |
| `slavemode.ollama-list` | `{}` |
| `slavemode.ollama-pull` | `{"model": "qwen3:8b"}` |
| `slavemode.ollama-delete` | `{"model": "qwen3:8b"}` |
| `slavemode.onnx-models-list` | `{}` |
| `slavemode.onnx-models-prepare` | `{"model": "nudenet"}` |
| `slavemode.onnx-models-delete` | `{"model": "nudenet"}` |
| `slavemode.special-caps-ctrl` | `{"get": true}` |

```bash
curl -s -X POST http://127.0.0.1:3069/testing/tasks/issue_slavemode_command \
  -H "Authorization: Bearer this-is-for-testing-management-tokens" \
  -H "Content-Type: application/json" \
  -d '{"command": "force-rescan", "targetAgentId": "01ABC…"}'
```

### Lifecycle observed by the mock

Once a task is injected:

1. `GET /private/agent/task/poll[_urgent]` returns the `UnassignedTask`
   (`{id, data, createdAt}`) to the first agent whose registered capabilities
   include the base capability — and, if `targetAgentId` is set, only to that
   agent.
2. `POST /private/agent/take/{cap}/{id}` marks it `assigned` and returns an
   `AssignedTask`-shaped body. A second take returns `404`.
3. `POST /private/agent/task/progress/{cap}/{id}` appends to `log`, updates
   `stage`, and applies `status` if provided.
4. `POST /private/agent/task/resolve/{cap}/{id}` sets the final status —
   `success` → `completed`, anything else → `failed` — and records `output`.
   If `/management/tasks/cancel/{cap}/{id}` ran first, status transitions to
   `canceled` instead.

`/testing/tasks/{cap}/{id}` and `/management/tasks/list` reflect every step
along the way.

---

## Testing

```bash
task test
# or: venv/bin/python -m pytest tests -q
```

The suite covers schema shapes, camelCase keys, the error envelope, capability
reporting, the storage round-trip ([`tests/test_smoke.py`](tests/test_smoke.py))
and the full inject → poll → take → progress → resolve lifecycle through the
testing surface ([`tests/test_testing_api.py`](tests/test_testing_api.py)).

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `403 authorization_error` on `/api/*` | Missing/invalid client key. Send `X-API-Key` or `apiKey` body field. |
| `403` on `/management/*` | Missing `Authorization: Bearer <mgmt-token>`. |
| `403 Incorrect API key` on register | `apiKey` not in `AGENT_API_KEYS`. |
| `422 Unprocessable Entity` | Body failed schema validation (e.g. missing `systemInfo.cpuArch`). FastAPI default validation error. |
| Agent registers but `~/.offloadmq-agent.json` changed | Expected — the agent rewrites it. See the [config caveat](#using-with-the-v2-agent). |
| State disappeared | In-memory only; restarting the mock clears everything. |
| Port in use | `task run PORT=8000` or free `:3069`. |

---

## Keeping in sync with the Rust server

OffloadMock's value is exact fidelity. When these change, update the matching
mock module:

| Rust source | Mock module |
|-------------|-------------|
| `src/schema.rs` | `offloadmock/schemas.py` |
| `src/models.rs` (`Agent`, `ClientApiKey`) | `offloadmock/state.py`, `schemas.py` |
| `src/error.rs` (`AppError`) | `offloadmock/errors.py` |
| `src/main.rs` (route tree) | `offloadmock/main.py`, `routers/*` |
| `src/middleware/auth.rs` | `offloadmock/deps.py`, `auth.py` |
| `src/config.rs` | `offloadmock/config.py` |

After changes, run `task test` and `task routes` to confirm parity.
