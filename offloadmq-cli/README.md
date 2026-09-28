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
  list      List agents or online capabilities
  describe  Show full details for a single resource
  delete    Delete a resource
  agent     Run a slavemode command (self-management task) on one agent
  status    One-shot dashboard: online agents, running/scheduled tasks, bucket quotas, and available capabilities
  help      Print this message or the help of the given subcommand(s)
```

### `list`

```bash
omqcli list agents [--online]     # table: short id, name, status, tier, capacity, load, caps, last contact
omqcli list caps [--ext]          # online capabilities; --ext includes bracketed attributes
```

`list caps` (alias `list capabilities`) hits `/management/capabilities/list/online`
(or `/online_ext` with `--ext`) — the same extended-capability convention documented
in the root [CLAUDE.md](../CLAUDE.md#extended-capability-attributes).

### `describe`

```bash
omqcli describe agent <id>
```

Prints every field the server tracks for one agent: uid, short id, display name,
online/offline + WebSocket-connected status, registration/last-contact timestamps,
tier, capacity, in-flight count, app version, full capability list, and — when
present — system info (OS, CPU, GPU, total memory, machine fingerprint).

### `delete`

```bash
omqcli delete agent <id> [-y|--yes]
```

Permanently removes an agent from the registry (`POST /management/agents/delete/{id}`).
Prompts for confirmation unless `-y`/`--yes` is passed.

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
   5), oldest first — from `GET /management/tasks/list`. "Running" is
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

- `auth`, `list`, `describe`, `delete`, `status` all call the **management API**
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
| [`src/commands/`](src/commands/) | One module per top-level command (`auth.rs`, `list.rs`, `describe.rs`, `delete.rs`, `agent.rs`, `status.rs`) |
