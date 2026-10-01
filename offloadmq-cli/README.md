# offloadmq-cli (`omqcli`)

A standalone, single-binary command-line client for the OffloadMQ **management API**.
It talks to a running OffloadMQ server over HTTP using the `MGMT_TOKEN` management
key — the same credential the [management frontend](../management-frontend/) uses —
so it needs no client API key and no agent registration key. It's meant for
operators inspecting and controlling a fleet from a terminal or a script.

It is its own standalone Cargo crate (own `Cargo.toml`/`Cargo.lock`), not part of
the root server crate's build — it lives entirely in this directory and is built
independently:

```bash
cd offloadmq-cli
cargo build --release
./target/release/omqcli --help
```

The binary is named `omqcli`.

## Authentication

Run `auth` once; it stores the server URL and management token in
`~/.omqcli.yaml` (mode `0600` on Unix):

```bash
omqcli auth --key <management-token> [--server https://mq.example.com]
```

- `--key` is required — it's the server's `MGMT_TOKEN` (see the main repo's
  [CLAUDE.md](../CLAUDE.md#local-dev-api-keys-from-env), local dev default:
  `this-is-for-testing-management-tokens`).
- `--server` defaults to `http://localhost:3069` if omitted and not already saved.
- `auth` immediately calls `GET /management/version` to verify the key; a bad key
  still saves the config but prints a `WARN` instead of `OK`.

Every other command loads `~/.omqcli.yaml` via `Config::require()` and fails with
an actionable error (`not authenticated — run omqcli auth --key ... first`) if it's
missing.

## Command reference

```
omqcli <COMMAND>

Commands:
  auth      Save the management API key (and optionally the server URL) to ~/.omqcli.yaml
  list      List agents, online capabilities, or tasks
  describe  Show full details for a single resource
  delete    Delete a resource
  agent     Run a slavemode command (self-management task) on one agent
  status    One-shot dashboard: online agents, running/scheduled tasks, bucket quotas, and available capabilities
  logs      Fetch agent records or Kubernetes pod diagnostics and logs
  heuristics Inspect execution-history records and aggregate statistics
  storage   Inspect and manage buckets owned by every client API key
  cancel    Cancel a running or queued resource
  reset     Reset (permanently clear) all of a resource type
  help      Print this message or the help of the given subcommand(s)
```

### `list`

```bash
omqcli list agents [--online]     # table: short id, name, status, tier, capacity, load, caps, last contact
omqcli list caps [--ext]          # online capabilities; --ext includes bracketed attributes
omqcli list tasks [--unassigned-only] [--cap <capability>]
```

`list caps` (alias `list capabilities`) hits `/management/capabilities/list/online`
(or `/online_ext` with `--ext`) — the same extended-capability convention documented
in the root [CLAUDE.md](../CLAUDE.md#extended-capability-attributes).

`list tasks` is the full task-control view — see [Task control](#task-control-list-tasks-describe-task-cancel-task-reset-tasks)
below.

### `describe`

```bash
omqcli describe agent <id>
omqcli describe task <capability> <id>
```

`describe agent` prints every field the server tracks for one agent: uid, short
id, display name, online/offline + WebSocket-connected status,
registration/last-contact timestamps, tier, capacity, in-flight count, app
version, full capability list, and — when present — system info (OS, CPU, GPU,
total memory, machine fingerprint).

`describe task` is covered below.

### `delete`

```bash
omqcli delete agent <id> [-y|--yes]
```

Permanently removes an agent from the registry (`POST /management/agents/delete/{id}`).
Prompts for confirmation unless `-y`/`--yes` is passed.

### Task control: `list tasks`, `describe task`, `cancel task`, `reset tasks`

Full parity with the management frontend's Tasks page (`TasksPage.jsx` /
`TaskDataRenderer.jsx`) — everything it can do to a task, `omqcli` can do too.
All four commands hit `/management/tasks/*` and need only the management token
(no client API key, no task ownership check — that's the point of the
management override).

```bash
omqcli list tasks                              # every task, grouped urgent/regular × assigned/unassigned
omqcli list tasks --unassigned-only             # only queued tasks (mirrors the UI's "Unassigned only" toggle)
omqcli list tasks --cap llm.mistral             # only tasks for one capability (not in the UI, added for convenience)

omqcli describe task llm.mistral 01ARZ3NDE4V2XTGZUVY7   # full detail: metadata, payload, result, log, history

omqcli cancel task llm.mistral 01ARZ3NDE4V2XTGZUVY7      # prompts for confirmation
omqcli cancel task llm.mistral 01ARZ3NDE4V2XTGZUVY7 -y   # skip the prompt

omqcli reset tasks                              # DESTRUCTIVE — clears every task, prompts for confirmation
omqcli reset tasks -y                           # skip the prompt
```

- **`list tasks`** fetches `GET /management/tasks/list` (all four buckets:
  urgent/regular × assigned/unassigned) and prints one table per non-empty
  bucket — task id, capability, status, stage, agent (resolved to short
  id + name), flags (`urgent`/`restartable`), and creation time. The server
  caps every bucket (default 200, newest first); `--limit N` (max 1000),
  `--status active|terminal|all` and `--all` (status=all, limit=1000) tune it, and
  a `note:` line on stderr says when anything was cut off. `--unassigned-only`
  and `--cap` filter the fetched rows client-side.
- **`describe task <cap> <id>`** scans the same response for a matching
  `(cap, id)` — there's no server-side get-by-id endpoint, only the full list —
  and prints everything: which queue/bucket it's in, status/stage, timestamps,
  assigned agent, flags, the full JSON payload, the result (on
  completion/failure), the accumulated log, and the history of state
  transitions. Errors clearly if the task isn't found (it may already be
  archived/expired).
- **`cancel task <cap> <id>`** calls `POST /management/tasks/cancel/{cap}/{id}`
  with the management override, which — unlike the client-facing cancel
  endpoint — bypasses API-key ownership checks entirely. Works on both urgent
  and regular tasks, queued or in-flight; queued tasks cancel immediately,
  in-flight tasks move to `cancelRequested` (the agent gets HTTP 499 on its
  next progress/resolve call). Fails with `404` if the task doesn't exist or
  `409` if it's already terminal/cancel-requested.
- **`reset tasks`** calls `POST /management/tasks/reset` — clears **every**
  task, in-memory and persisted, with no way to undo it. Same destructive
  operation as the Tasks page's "Reset" button. Always confirms unless `-y`.

### `status`

```bash
omqcli status [--task-limit N]    # default N = 5
```

A one-shot fleet dashboard. Makes four read-only management API calls and prints:

1. **Online agents** — one row per agent with `last_contact` within 120s: short
   id, name, tier, capacity, current load, OS, CPU, GPU, total memory, app
   version, and an aggregate **success rate**. The success rate is *not* a single
   field from the server — it's computed by fetching
   `GET /management/heuristics/stats/runners` (per `(capability, runner)` stats)
   and summing `totalRuns`/`successCount` across every capability for that
   agent's uid, so it reflects the agent's overall track record, not just one
   capability. Shows `-` for an agent with no heuristic history yet.
2. **Running tasks** and **scheduled tasks** (up to `--task-limit` each, default
   5), oldest first — from `GET /management/tasks/list?status=active`. "Running" is
   `urgent.assigned` + `regular.assigned` (already claimed by an agent);
   "scheduled" is `urgent.unassigned` + `regular.unassigned` (queued, waiting
   for one). Each line shows the task id, its agent (for running tasks), status/
   stage, and age; a `... and N more` line appears if the total exceeds the limit.
3. **Storage buckets** — from `GET /management/storage/quotas`: one row per
   client API key that owns at least one bucket, showing its current bucket
   count against the server-wide `max_buckets_per_key` limit
   (`STORAGE_MAX_BUCKETS_PER_KEY`, see the root
   [CLAUDE.md](../CLAUDE.md#storage-configuration)).
4. **Available capabilities** — the same base (non-extended) capability set as
   `list caps`, i.e. everything currently provided by an online agent.

Exit code is non-zero only if one of the underlying API calls fails (e.g. bad
management token, server unreachable) — an empty fleet or task queue is not an
error and prints `none` for that section.

### `logs`

```bash
# Latest persisted records across all agents; limit defaults to 100.
omqcli logs agent
omqcli logs agent --agent <agent-uid> --limit -1
omqcli logs agent --severity ERROR --severity CRITICAL --limit 200

# Kubernetes diagnostics for the server or management frontend (in-cluster only).
omqcli logs pod --component server --tail-lines 500
omqcli logs pod --component frontend --container frontend --timestamps
omqcli logs pod --previous
```

`logs agent` mirrors the Agent Logs page: with no filter it reads the latest
records; `--agent` fetches every severity for one agent; repeated `--severity`
fetches, merges, sorts, and limits the selected severities exactly as the page
does. It prints the timestamp, severity, agent name/UID, machine fingerprint,
and message.

`logs pod` mirrors the Pod Logs page by showing pod/container readiness,
restart state, and the requested container's logs. `--previous` selects the
previous terminated instance; `--tail-lines`, `--container`, and `--timestamps`
map directly to the frontend controls. These commands require the server to run
in Kubernetes with its in-cluster service-account configuration; a non-cluster
server returns the same management API error as the frontend.

### `heuristics`

```bash
omqcli heuristics records [--capability <cap>] [--runner-id <uid>] \
  [--machine-id <id>] [--limit 50] [--cursor <cursor>]
omqcli heuristics runners
omqcli heuristics machines
```

These commands cover the management frontend's three Heuristics views. `records`
shows raw completed-task timings and accepts the page filters and cursor; its
stderr output prints a ready-to-copy cursor when more records exist. `runners`
shows the per-capability/agent aggregates, while `machines` combines the
per-capability rows into the same per-machine totals shown by the frontend.

### `storage`

```bash
omqcli storage list
omqcli storage quotas [--api-key <client-key>]
omqcli storage delete <bucket-uid> [-y|--yes]
omqcli storage delete-key <client-key> [-y|--yes]
omqcli storage purge [-y|--yes]
```

`storage list` is the Storage page in terminal form: it combines bucket groups,
per-bucket file/byte/task details, and the configured quota limits. `quotas`
prints the same quota/usage data and can narrow it to one API key.

The three delete commands map to the page's bucket, per-key, and global purge
actions. They permanently remove staged files and metadata, so each asks for
confirmation unless `-y`/`--yes` is supplied.

### `agent <id> <action>` — slavemode commands

Runs a `slavemode.*` self-management task on one specific agent and waits for the
result. See the root [`docs/slavemode-capabilities.md`](../docs/slavemode-capabilities.md)
for the full server-side contract this wraps.

```
omqcli agent <ID> <COMMAND>

Commands:
  force-rescan  Re-detect capabilities and push the updated list to the server
  update        Check for, or install, an agent binary update
  caps          Manage custom capability definitions
  ollama        Manage Ollama models
  onnx          Manage ONNX models
```

| Command | Server capability | Notes |
|---|---|---|
| `agent <id> force-rescan` | `slavemode.force-rescan` | Re-detects all capabilities (Ollama models, Docker, custom caps, …) and pushes the list to the server. Prints `{"caps": [...], "count": N}`. |
| `agent <id> update [--check]` | `slavemode.agent-update` | `--check` only reports `{current, latest, has_update}` — nothing changes. Without `--check`, starts an update if a newer release exists; the task resolves immediately (`updating: true/false`) and the actual swap-and-restart happens afterwards on the agent, once idle. Watch the agent's `appVersion` (via `describe agent`) to confirm it landed. Only advertised by agents that can self-update (release-stamped Linux `omq` build under systemd) and only if allow-listed. |
| `agent <id> caps get` | `slavemode.special-caps-ctrl` (`{"get": true}`) | Lists the agent's custom capability definitions. |
| `agent <id> caps set <json\|@file>` | `slavemode.special-caps-ctrl` (`{"set": {...}}`) | Creates/replaces a custom capability. Accepts a literal JSON object or `@path/to/file.json`. Triggers a rescan-and-push afterwards. |
| `agent <id> caps delete <name>` | `slavemode.special-caps-ctrl` (`{"delete": "<name>"}`) | Removes a custom capability by name. Triggers a rescan-and-push afterwards. |
| `agent <id> ollama list` | `slavemode.ollama-list` | Lists installed Ollama models. |
| `agent <id> ollama pull <model>` | `slavemode.ollama-pull` | Downloads an Ollama model; streams progress on the agent side. Default `--timeout 1800`. |
| `agent <id> ollama delete <model>` | `slavemode.ollama-delete` | Deletes an installed Ollama model. |
| `agent <id> onnx list` | `slavemode.onnx-models-list` | Lists known ONNX models and their install state. |
| `agent <id> onnx prepare <model>` | `slavemode.onnx-models-prepare` | Downloads an ONNX model; streams progress. Default `--timeout 1800`. |
| `agent <id> onnx delete <model>` | `slavemode.onnx-models-delete` | Deletes a downloaded ONNX model. |

Every `agent` subcommand accepts `--timeout <seconds>` (default `60`, or `1800` for
`ollama pull` / `onnx prepare`). All of these exit non-zero and print the failure
reason if the task ends in a non-`completed` status — including "not allowed" errors
when the target agent hasn't enabled that capability in its
`slavemode_allowed_caps` allow-list (see
[`docs/slavemode-capabilities.md`](../docs/slavemode-capabilities.md#security-model)).

## Agent identifiers

Everywhere an `<id>` is accepted (`describe agent`, `delete agent`, `agent <id> ...`),
you can pass any of:

- the full agent UID
- the short ID shown in `list agents`
- the agent's display name (case-insensitive exact match)
- a case-insensitive suffix of the UID
- the machine fingerprint (`system_info.machine_id`)

If more than one agent matches, the command fails and lists the candidates instead
of guessing.

## How it talks to the server

- `auth`, `list`, `describe`, `delete`, `status`, `cancel`, `reset` all call the **management API**
  (`/management/*`), authenticated with `Authorization: Bearer <management-token>`.
- `agent <id> <action>` calls the **client API**'s blocking submit endpoint
  (`POST /api/task/submit_blocking`) using the **management override** header
  (`X-MGMT-API-KEY: <management-token>`) instead of a client API key — see
  [`docs/tasks-api.md#management-override-x-mgmt-api-key`](../docs/tasks-api.md#management-override-x-mgmt-api-key).
  This is the same mechanism the management frontend's slavemode buttons use
  (`management-frontend/src/components/agents/slavemodeApi.js`).
- Every `agent` task is submitted as `urgent: true` with `payload.runner` set to
  the resolved agent's UID. `runner` pins the task to that one agent — the
  scheduler (`src/mq/regular.rs`, `src/mq/urgent.rs`) skips the task for every
  other agent even if they share the capability. Without this pin, a capability
  shared by several online agents could be picked up by the wrong one.
- `--timeout` is sent as `maxWaitSecs`. On the server this is not just "how long to
  wait for pickup" — for an urgent task it is also the maximum silence allowed
  between progress updates *after* pickup before the task is failed (see
  `expire_tasks` in `src/mq/urgent.rs`). That's why long-running operations
  (`ollama pull`, `onnx prepare`) need a generous timeout even though they stream
  progress: each individual gap between progress messages must stay under it, not
  just the total run time. The CLI does not set `timeoutSecs` (the hard wall-clock
  deadline), so a task with steady progress can run indefinitely.
- The HTTP client's own request timeout is `--timeout` + 15s headroom, so it never
  cuts the connection before the server-side deadline would.

## Configuration file

`~/.omqcli.yaml`:

```yaml
server: http://localhost:3069
key: this-is-for-testing-management-tokens
```

Both fields are optional in isolation, but `key` must be set (via `auth`) before
any other command will run. Re-run `auth` to change either value.

Every HTTP request times out after 15 s by default. Raise it for a slow server
with the global `--http-timeout <secs>` flag or `OMQCLI_HTTP_TIMEOUT=<secs>`
(slavemode commands keep their own `--timeout`, which is the agent wait).

## Adding a new `agent` slavemode subcommand

1. Confirm the capability is implemented and allow-listed on the agent side —
   see [`docs/slavemode-capabilities.md#extending-slavemode`](../docs/slavemode-capabilities.md#extending-slavemode).
2. Add a thin wrapper in [`src/commands/agent.rs`](src/commands/agent.rs) that calls
   the shared `run(id, capability, payload, timeout_secs)` helper — it already
   handles agent resolution, `runner` pinning, submission, and result printing.
3. Add the matching `clap` variant/subcommand in [`src/main.rs`](src/main.rs) (see
   `AgentAction`, `CapsAction`, `OllamaAction`, `OnnxAction`) and wire it into the
   `match` in `main()`.
4. No changes are needed in `src/client.rs` or `src/output.rs` — `run_slavemode`
   and `print_slavemode_result` are capability-agnostic; they just forward
   whatever payload/result shape the capability uses.

## Source layout

| File | Responsibility |
|---|---|
| [`src/main.rs`](src/main.rs) | `clap` CLI definition (`Cli`, `Command`, and all subcommand enums) and dispatch |
| [`src/client.rs`](src/client.rs) | HTTP client: management API calls + `run_slavemode` (blocking task submit) |
| [`src/config.rs`](src/config.rs) | `~/.omqcli.yaml` load/save |
| [`src/models.rs`](src/models.rs) | `Agent` and related structs deserialized from the management API, plus id-matching logic |
| [`src/output.rs`](src/output.rs) | Table/detail printing, agent resolution, slavemode result printing |
| [`src/commands/`](src/commands/) | One module per top-level command (`auth.rs`, `list.rs`, `describe.rs`, `delete.rs`, `agent.rs`, `status.rs`, `task.rs`) — `task.rs` backs `list tasks`/`describe task`/`cancel task`/`reset tasks` |
