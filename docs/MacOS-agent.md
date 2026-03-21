# macOS Agent — Permanent Installation

This document describes how to set up the offload-agent as a permanent background service on macOS using `launchd`.

## Prerequisites

- Agent source at `/Users/vedmedik/dev/offloadmq/offload-agent`
- Python venv already created (`make venv` in `offload-agent/`)

## Setup Steps

### 1. Register the agent

```bash
cd offload-agent
source venv/bin/activate
python offload-agent.py cli register \
  --server https://offloadmq.alexgr.space \
  --key <agent_api_key>
```

This saves credentials to `offload-agent/.offload-agent.json` and verifies connectivity.

### 2. Install the LaunchAgent plist

Create `~/Library/LaunchAgents/com.offloadmq.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.offloadmq.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/vedmedik/dev/offloadmq/offload-agent/venv/bin/python</string>
        <string>/Users/vedmedik/dev/offloadmq/offload-agent/offload-agent.py</string>
        <string>cli</string>
        <string>serve</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/vedmedik/dev/offloadmq/offload-agent</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/vedmedik/Library/Logs/offload-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/vedmedik/Library/Logs/offload-agent.log</string>
</dict>
</plist>
```

### 3. Load the service

```bash
launchctl load ~/Library/LaunchAgents/com.offloadmq.agent.plist
```

## Registered Node Info

| Field | Value |
|---|---|
| Server | `https://offloadmq.alexgr.space` |
| Agent ID | `01KM9BZCDYPEJEJK8TNV222K73` |
| Capabilities | `debug.echo`, `llm.moondream`, `shell.bash`, `shellcmd.bash`, `tts.kokoro` |
| Tier | 5 |
| Capacity | 1 |
| System | Darwin arm64, Apple M3, 16 GB RAM |

## Operations

```bash
# View live logs
tail -f ~/Library/Logs/offload-agent.log

# Check service status
launchctl list com.offloadmq.agent

# Restart
launchctl kickstart -k gui/$(id -u)/com.offloadmq.agent

# Stop
launchctl unload ~/Library/LaunchAgents/com.offloadmq.agent.plist

# Remove permanently
launchctl unload ~/Library/LaunchAgents/com.offloadmq.agent.plist
rm ~/Library/LaunchAgents/com.offloadmq.agent.plist
```

## Notes

- `KeepAlive: true` — launchd automatically restarts the agent if it crashes
- `RunAtLoad: true` — starts immediately on load and at every login
- The `WorkingDirectory` must point to the `offload-agent/` source dir so `.offload-agent.json` is found correctly
- The `install launchd` subcommand in `offload-agent.py` only works for frozen `.app` bundles; use this manual plist approach for source installations
