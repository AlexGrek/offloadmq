# Agent v2 migration from legacy offload-agent

## Config file

| Legacy (`~/.offload-agent.json`) | v2 (`.offloadmq-agent.json` in CWD) |
|----------------------------------|-------------------------------------|
| `apiKey` | `api_key` |
| `displayName` | `display_name` |
| `webuiPort` | `webui_port` |
| `regular-disabled-caps` | `regular_disabled_caps` |
| `sensitive-allowed-caps` | `sensitive_allowed_caps` |
| `slavemode-allowed-caps` | `slavemode_allowed_caps` |
| `capacity` | `max_concurrent` |
| `transport` | *(dropped — v2 uses HTTP polling only)* |

Import:

```bash
cd agent_v2
uv run omq config import-legacy
```

## UI parity

v2 adds routes under `/api/*` for connection, tiered capabilities, slavemode, custom caps, ComfyUI workflows, system/update/startup, raw config, and agent logs. See `agent_v2/ui-server/src/ui_server/api.py`.

## Executors

Native async executors: `debug.*`, `shell.*`, `llm.*`.

All other capability families (`docker.*`, `imggen.*`, `txt2music.*`, `onnx.*`, `custom.*`, `slavemode.*`, `tts.kokoro`, `shellcmd.bash`) run through the v2 task pipeline (`offloadmq_agent/pipeline.py`) with ported executor modules under `offloadmq_agent/exec/`.

## Parity checklist

- [x] Tiered capability policy (regular/sensitive/slavemode)
- [x] Capability rescan + background scheduler
- [x] Push capabilities to server while running
- [x] Urgent + non-urgent poll
- [x] Remote progress reporting
- [x] Task list/detail/cancel (v2-only)
- [x] Custom cap YAML CRUD
- [x] ComfyUI workflow listing + URL config
- [x] System info, updater, OS startup, systemd install
- [x] Raw JSON config editor
- [x] Global agent log tail
- [x] HTTP polling only (no WebSocket transport in v2)
