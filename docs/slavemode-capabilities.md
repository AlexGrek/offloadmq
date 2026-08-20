# Slavemode Capabilities

Slavemode capabilities let the server instruct agents to perform **control operations on themselves** — capability rescans, config reloads, and other self-management tasks.

## Security Model

By default, **all slavemode capabilities are disabled**. An agent only executes a slavemode task if the capability is explicitly listed in its allow-list config key:

```json
{
  "slavemode_allowed_caps": ["slavemode.force-rescan"]
}
```

If the key is absent or empty, all slavemode tasks are rejected with a clear error message.

> **Config key name.** agent_v2 (`~/.offloadmq-agent.json`) uses `slavemode_allowed_caps`;
> the legacy offload-agent uses the hyphenated `slavemode-allowed-caps`. agent_v2 still reads
> the hyphenated spelling as a fallback so v1 configs survive an import, but it always
> *writes* the underscored key — prefer it for anything new.

The same allow-list governs both **what the agent advertises** at registration and **what it
will execute**: a cap that is not allow-listed is never registered, so the scheduler will not
route that task to this agent in the first place.

## Available Capabilities

agent_v2 implements the catalog below (`agent_v2/agent/src/offloadmq_agent/slavemode_policy.py`
→ `ALL_SLAVEMODE_CAPS`). Each is opt-in via the allow-list. The legacy offload-agent implements
`slavemode.force-rescan` only.

| Capability | Payload | Purpose |
|---|---|---|
| `slavemode.force-rescan` | `{}` | Re-detect capabilities and push the new list to the server |
| `slavemode.special-caps-ctrl` | `{"get": true}` / `{"set": {...}}` / `{"delete": "<name>"}` | List, create/replace, or remove a custom capability definition |
| `slavemode.ollama-list` | `{}` | List installed Ollama models |
| `slavemode.ollama-pull` | `{"model": "<name>"}` | Pull an Ollama model (streams progress) |
| `slavemode.ollama-delete` | `{"model": "<name>"}` | Delete an installed Ollama model |
| `slavemode.onnx-models-list` | `{}` | List known ONNX models and their install state |
| `slavemode.onnx-models-prepare` | `{"model": "<name>"}` | Download an ONNX model (streams progress) |
| `slavemode.onnx-models-delete` | `{"model": "<name>"}` | Delete a downloaded ONNX model |

Any cap that changes what the agent can do (`special-caps-ctrl`, and the `onnx-models-*`
mutations) runs a rescan-and-push afterwards, so the server's view stays current without a
separate `force-rescan`.

### First-launch defaults (agent_v2)

To make a fresh node useful without hand-editing config, agent_v2 seeds the allow-list **once**:

- Ollama caps (`ollama-list` / `ollama-pull` / `ollama-delete`) when an `llm.*` capability is detected
- ONNX caps (`onnx-models-*`) when `onnxruntime` is present

Seeding is recorded via the `ollama_slavemode_initialized` / `onnx_slavemode_initialized` flags,
so it happens at most once per agent. Clearing the allow-list afterwards (the Slavemode tab's
**Deny all**) is respected permanently and is never silently repopulated.

### `slavemode.force-rescan`

**Purpose:** Re-detect all agent capabilities and push the updated list to the server.

**Behavior:**
1. Agent runs all capability checks (Ollama models, Docker, custom caps, etc.)
2. Publishes updated capability list to server via `update_agent_capabilities()`
3. Returns count of detected capabilities and the full list in the task result

**Use cases:**
- Server detected that a new Ollama model was installed on the agent → instruct rescan
- Docker daemon is now running after being offline → rescan to advertise docker.* capabilities
- Custom capabilities were added to the agent's caps directory → rescan to register them
- Testing capability detection logic without restarting the agent

**Payload:** Empty dict `{}`

**Result (on success):**
```json
{
  "caps": ["debug.echo", "shell.bash", "shellcmd.bash", "tts.kokoro", "slavemode.force-rescan", ...],
  "count": 12
}
```

**Result (on failure — not allowed):**
```
Slavemode capability 'slavemode.force-rescan' is not enabled. Add it to 'slavemode_allowed_caps' in the agent config to allow it.
```

## Managing Permissions

### agent_v2 — Web UI

The agent's own dashboard has a dedicated **Slavemode** page (`/slavemode`) listing every
implemented capability with a checkbox, plus **Allow all** / **Deny all**. Changes save
immediately to `~/.offloadmq-agent.json` and, when the agent is online, trigger a capability
push so the server's view updates without a restart.

### agent_v2 — Direct Config Edit

```json
{
  "server": "https://mq.example.com",
  "api_key": "...",
  "slavemode_allowed_caps": ["slavemode.force-rescan"]
}
```

The raw JSON editor at `/config` in the agent dashboard edits the same file.

### Legacy offload-agent — CLI

Manage the allow-list via the `slavemode` CLI sub-command:

```bash
# Show which slavemode capabilities are allowed
offload-agent slavemode status

# Enable all slavemode capabilities
offload-agent slavemode allow-all

# Disable all slavemode capabilities
offload-agent slavemode deny-all

# Allow a specific capability
offload-agent slavemode allow slavemode.force-rescan

# Deny a specific capability
offload-agent slavemode deny slavemode.force-rescan
```

Example output:
```
Config key: slavemode-allowed-caps

  ✅ slavemode.force-rescan
  ❌ slavemode.config-reload

No slavemode capabilities are allowed. Run 'slavemode allow-all' to enable them.
```

### Legacy offload-agent — Web UI

The capabilities tab includes a **Slavemode** section (amber styling) where operators can:
- View all available slavemode capabilities
- Toggle individual permissions
- Enable/disable all at once
- Changes are persisted to the agent config

### Legacy offload-agent — Direct Config Edit

Edit the agent's config file (typically `~/.offload-agent/config.json`):

```json
{
  "server": "https://mq.example.com",
  "apiKey": "...",
  "slavemode-allowed-caps": ["slavemode.force-rescan"]
}
```

## Server-Side Usage

Clients submit tasks with base capability only (no brackets). The scheduler matches tasks to agents and dispatches them.

### With a client API key

```bash
curl -X POST https://mq.example.com/api/task/submit \
  -H "Content-Type: application/json" \
  -d '{
    "capability": "slavemode.force-rescan",
    "payload": {},
    "apiKey": "<client_api_key>"
  }'
```

### With the management token (`X-MGMT-API-KEY`)

The management frontend (and any admin tooling) can submit tasks without a client API key by passing the management token in the `X-MGMT-API-KEY` header. This bypasses client key validation and capability restrictions:

```bash
curl -X POST https://mq.example.com/api/task/submit \
  -H "Content-Type: application/json" \
  -H "X-MGMT-API-KEY: <management_token>" \
  -d '{
    "capability": "slavemode.force-rescan",
    "payload": {},
    "apiKey": "mgmt"
  }'
```

The `apiKey` field must be present for JSON parsing but its value is not validated when `X-MGMT-API-KEY` is used. Any placeholder (e.g. `"mgmt"`) works.

See [management-api.md#using-client-api-with-management-token](management-api.md#using-client-api-with-management-token) for full details.

### Task Rejection

If the agent does not have `slavemode.force-rescan` in its allow-list:

**Agent logs:**
```
[WARNING] [slavemode] Slavemode capability 'slavemode.force-rescan' is not enabled. Add it to 'slavemode_allowed_caps' in the agent config to allow it.
```

**Task result (Failed):**
```json
{
  "status": "Failed",
  "output": "Slavemode capability 'slavemode.force-rescan' is not enabled. Add it to 'slavemode_allowed_caps' in the agent config to allow it.",
  "logs": []
}
```

## Executor Behavior

The slavemode executor is routed by capability prefix in `route_executor()`:

```python
if cap.startswith("slavemode."):
    return execute_slavemode
```

All slavemode capabilities follow this flow:

1. **Permission check:** Is the capability in the allow-list?
   - ✅ Yes → proceed
   - ❌ No → return failure report and reject

2. **Capability dispatch:** Match the capability string to an implementation
   - `slavemode.force-rescan` → run capability detection + push to server
   - Unknown → return error

3. **Report result:** Post task result back to server (success or failure)

## Logging

Slavemode tasks produce structured logs prefixed with `[slavemode]`:

```
[INFO] [slavemode] force-rescan: starting capability detection
[INFO] [cap] + debug.echo: built-in, always available
[INFO] [cap] + shell.bash, shellcmd.bash: bash found at /bin/bash
[INFO] [cap] + tts.kokoro: Kokoro reachable at http://localhost:8000, voices: af, am, en_au, ...
[INFO] [slavemode] force-rescan: pushed 12 capabilities
```

## Extending Slavemode

To add a new slavemode capability to **agent_v2**:

1. **Declare it** in `agent_v2/agent/src/offloadmq_agent/slavemode_policy.py` — this list is the
   single source of truth for what may be advertised *and* what may execute:
   ```python
   ALL_SLAVEMODE_CAPS: list[str] = [
       "slavemode.force-rescan",
       "slavemode.my-new-capability",  # ← add here
       ...
   ]
   ```

2. **Implement the handler** in `agent_v2/agent/src/offloadmq_agent/exec/slavemode.py`:
   ```python
   def _my_new_capability(
       transport: AgentTransport, task_id: TaskId, capability: str
   ) -> bool:
       logger.info("[slavemode] my-new-capability: starting...")
       # ... implementation ...
       report = make_success_report(task_id, capability, result_data)
       return report_result(transport, report)
   ```
   If the capability changes what the agent can do, finish with
   `rescan_and_push(transport, ...)` so the server sees the new capability set.

3. **Add a match case** in `execute_slavemode()`:
   ```python
   match capability:
       case "slavemode.force-rescan":
           return _force_rescan(transport, task_id, capability)
       case "slavemode.my-new-capability":  # ← add here
           return _my_new_capability(transport, task_id, capability)
       case _:
           # ... error handling
   ```

   No route registration is needed — `route_executor()` already sends the whole
   `slavemode.*` prefix to `execute_slavemode`.

4. **Expose it in the UI** — nothing to do. The Slavemode page renders
   `ALL_SLAVEMODE_CAPS` from `/api/capabilities/state`, so the new cap appears
   with a toggle automatically.

5. **Test it**, ideally against [OffloadMock](../offloadmock/DOCS.md), which can inject a
   slavemode task without the real server:
   ```bash
   curl -X POST http://127.0.0.1:3069/testing/tasks/issue_slavemode_command \
     -H "Authorization: Bearer <mgmt_token>" \
     -H "Content-Type: application/json" \
     -d '{"command": "my-new-capability"}'
   ```
   Add the default payload to `SLAVEMODE_COMMANDS` in `offloadmock/offloadmock/task_templates.py`
   so the mock's catalog stays in sync, and cover the allow/deny paths in
   `agent_v2/tests/test_slavemode.py`.

For the **legacy offload-agent**, the equivalent edits live in `offload-agent/app/exec/slavemode.py`
(handler + `ALL_SLAVEMODE_CAPS` + match case) and `offload-agent/app/cli.py`.

## Design Notes

### Why an Allow-List?

Slavemode capabilities let the server instruct the agent to reconfigure itself. An allow-list ensures:
- Operator intent — only explicitly allowed operations run
- Auditability — config shows exactly what self-management is permitted
- Gradual enablement — new capabilities are safe by default
- Attack surface reduction — deny by default principle

### Allow-List Persistence

The allow-list is stored in the agent's persistent config file and persists across:
- Agent restarts
- Re-authentication cycles
- Server disconnections

Changes via CLI or Web UI are immediately persisted to disk.

### Integration with Regular Capabilities

Slavemode is separate from the regular capability scan and from the `capabilities` config field. Control is only through the slavemode allow-list (Web UI Slavemode tab, CLI `slavemode` commands, or raw JSON).

When the agent registers or pushes updates to the server, it reports the union of:

- Regular capabilities: detected on the machine, filtered by the saved selection in `capabilities` (never include `slavemode.*` there)
- Slavemode capabilities: each cap must be implemented in the agent build and listed in the allow-list

The allow-list still gates **task execution**; caps not allow-listed are not advertised and will not run.

### No Payload Validation

Slavemode payloads are not validated — the executor receives the raw payload dict from the server. For `slavemode.force-rescan`, the payload is expected to be empty `{}`, but no validation is enforced at the executor level (the implementation simply ignores it).

## Troubleshooting

### Task rejected: "not enabled"

**Symptom:** Server submits a slavemode task but agent rejects it immediately.

**Check:**
```bash
offload-agent slavemode status
```

**Fix:** Enable the capability
```bash
offload-agent slavemode allow slavemode.force-rescan
```

### Rescan not discovering new capabilities

**Symptom:** Agent runs `slavemode.force-rescan` but capability count doesn't increase.

**Check agent logs:**
```bash
offload-agent serve --ws
# Look for [cap] lines showing pass/fail for each check
```

**Common causes:**
- Ollama server not running: `ollama serve` or check `OLLAMA_ROOT_URL` env var
- Docker daemon not running: `sudo systemctl start docker`
- Custom caps directory not writable or has incorrect YAML syntax
- New Ollama model not yet downloaded: `ollama pull <model>`

### Allow-list got corrupted

**Symptom:** the slavemode allow-list key in config has unexpected values.

**Fix:** Rebuild via CLI
```bash
offload-agent slavemode deny-all
offload-agent slavemode allow slavemode.force-rescan
offload-agent slavemode status
```

Or edit the config file directly:
```bash
# Verify it's valid JSON
cat ~/.offload-agent/config.json | jq .
```
