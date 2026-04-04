# Slavemode Capabilities

Slavemode capabilities let the server instruct agents to perform **control operations on themselves** — capability rescans, config reloads, and other self-management tasks.

## Security Model

By default, **all slavemode capabilities are disabled**. An agent only executes a slavemode task if the capability is explicitly listed in the `slavemode-allowed-caps` config key:

```json
{
  "slavemode-allowed-caps": ["slavemode.force-rescan"]
}
```

If the key is absent or empty, all slavemode tasks are rejected with a clear error message.

## Available Capabilities

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
Slavemode capability 'slavemode.force-rescan' is not enabled. Add it to 'slavemode-allowed-caps' in the agent config to allow it.
```

## Managing Permissions

### Agent CLI

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

### Web UI (Agent Management)

The capabilities tab includes a **Slavemode** section (amber styling) where operators can:
- View all available slavemode capabilities
- Toggle individual permissions
- Enable/disable all at once
- Changes are persisted to the agent config

### Direct Config Edit

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

If the agent does not have `slavemode.force-rescan` in its `slavemode-allowed-caps` list:

**Agent logs:**
```
[WARNING] [slavemode] Slavemode capability 'slavemode.force-rescan' is not enabled. Add it to 'slavemode-allowed-caps' in the agent config to allow it.
```

**Task result (Failed):**
```json
{
  "status": "Failed",
  "output": "Slavemode capability 'slavemode.force-rescan' is not enabled. Add it to 'slavemode-allowed-caps' in the agent config to allow it.",
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

To add a new slavemode capability:

1. **Implement the handler** in `offload-agent/app/exec/slavemode.py`:
   ```python
   def _my_new_capability(http: HttpClient, task_id: TaskId, capability: str) -> bool:
       logger.info("[slavemode] my-new-capability: starting...")
       # ... implementation ...
       report = make_success_report(task_id, capability, result_data)
       return report_result(http, report)
   ```

2. **Register in `ALL_SLAVEMODE_CAPS`**:
   ```python
   ALL_SLAVEMODE_CAPS = [
       "slavemode.force-rescan",
       "slavemode.my-new-capability",  # ← add here
   ]
   ```

3. **Add match case** in `execute_slavemode()`:
   ```python
   match capability:
       case "slavemode.force-rescan":
           return _force_rescan(http, task_id, capability)
       case "slavemode.my-new-capability":  # ← add here
           return _my_new_capability(http, task_id, capability)
       case _:
           # ... error handling
   ```

4. **Update CLI** in `offload-agent/app/cli.py` (validation against `ALL_SLAVEMODE_CAPS` happens automatically)

5. **Test via CLI:**
   ```bash
   offload-agent slavemode allow slavemode.my-new-capability
   offload-agent slavemode status
   ```

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

Slavemode is separate from the regular capability scan and from the `capabilities` config field. Control is only through `slavemode-allowed-caps` (Web UI Slavemode tab, CLI `slavemode` commands, or raw JSON).

When the agent registers or pushes updates to the server, it reports the union of:

- Regular capabilities: detected on the machine, filtered by the saved selection in `capabilities` (never include `slavemode.*` there)
- Slavemode capabilities: each cap must be implemented in the agent build and listed in `slavemode-allowed-caps`

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

**Symptom:** `slavemode-allowed-caps` key in config has unexpected values.

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
