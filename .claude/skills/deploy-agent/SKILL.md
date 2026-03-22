---
name: deploy-agent
description: DevOps context for deploying offload-agent nodes — Ansible fleet management, binary builds for Linux/macOS/Windows, source installs, GUI vs CLI (headless) modes, and adding/removing built-in and custom capabilities.
---

# Offload Agent — Deployment & Operations

## Quick Reference

| Scenario | Command |
|---|---|
| Ansible fleet deploy | `ansible-playbook playbooks/site.yml -i inventory/hosts.yml` |
| Build Linux binary | `cd offload-agent && make build` |
| Build macOS app | `cd offload-agent && ./build-mac.sh` |
| Build Windows exe | `cd offload-agent && .\build-windows.ps1` |
| Headless (systemd) | `offload-agent cli serve` |
| Web UI | `offload-agent webui` |
| Register / re-register | `offload-agent cli register --server URL --key KEY --caps cap1 cap2` |
| List custom caps | `offload-agent custom list` |
| Import custom cap | `offload-agent custom import /path/to/skill.yaml` |

---

## Versioning

Version is derived at build time from the git commit count:

```bash
git rev-list --count HEAD   # → e.g. 236
```

The Makefile uses `git describe --tags --always --dirty` as `VERSION`; the build scripts inject `git rev-list --count HEAD` into `app/_version.py`. Both are commit-count based — release tags follow `release-v0.2.<count>`.

---

## Building Binaries

### Linux — single ELF binary

**Build host must be Linux** (PyInstaller produces arch-specific binaries).

```bash
cd offload-agent
make build
# → dist/offload-agent  (single-file ELF)
```

`make build` does: venv → `pip install -r requirements.txt` → `npm ci && npm run build` (frontend) → PyInstaller `--onefile`. Clean rebuild: `make rebuild`.

Entry point: `offload-agent.py`. Produces a headless-capable binary — both `cli serve` and `webui` work.

**Prerequisites:** Python 3.10+, Node.js (for frontend build), pip.

### macOS — `.app` bundle with tray icon

```bash
cd offload-agent
./build-mac.sh
# → dist/Offload Agent.app
```

The script: creates `venv-mac/` → installs deps → builds frontend → runs mypy → runs PyInstaller `--windowed`. Entry point: `offload-agent-mac.py` (runs webui in daemon thread + pystray tray icon on main thread). `LSUIElement: true` keeps it out of the Dock.

**Install LaunchAgent (autostart at login):**
```bash
"dist/Offload Agent.app/Contents/MacOS/Offload Agent" install launchd
```

**Prerequisites:** Python 3.10+, Node.js, Xcode CLI tools.

### Windows — `.exe` with tray icon

```powershell
cd offload-agent
.\build-windows.ps1
# → dist\offload-agent.exe
```

The script: kills any running agent → creates `venv-win\` → installs deps + mypy → builds frontend → runs mypy → PyInstaller `--windowed --onefile`. Entry point: `offload-agent-win.pyw` (no console window). Tray icon via `pystray._win32`.

**Prerequisites:** Python 3.10+, Node.js, PowerShell 5.1+.

### Building from source (no binary)

No build step needed — run directly from the Python source tree:

```bash
cd offload-agent
make venv                           # creates venv/, installs requirements.txt
make frontend-build                 # builds frontend/dist (needed for webui)
source venv/bin/activate

python offload-agent.py cli register --server URL --key KEY
python offload-agent.py cli serve   # headless
python offload-agent.py webui       # web UI on :8080
```

Config file lives at `offload-agent/.offload-agent.json` (next to the entry point) when running from source. When running a binary, it lives in `{workdir}/` — the directory set as `WorkingDirectory` in the service unit.

---

## Deployment Modes

### CLI / Headless (production default)

The agent polls for tasks without opening any UI or port. This is the mode used for server-side fleet nodes.

**From binary (systemd):**

```bash
# Register once
offload-agent cli register --server https://offloadmq.example.com --key ak_live_...

# Serve (blocks — run via systemd in production)
offload-agent cli serve
# Or with WebSocket instead of HTTP polling:
offload-agent cli serve --ws
```

**Systemd service (manual, single node):**

```bash
make install-systemd SERVER=https://offloadmq.example.com KEY=ak_live_...
# Builds binary, installs to /usr/local/bin, registers, creates + starts service.

# If binary is already installed:
make register-systemd SERVER=https://offloadmq.example.com KEY=ak_live_...
```

The generated unit file runs `offload-agent cli serve` as the current user with `WorkingDirectory=$HOME`.

**Service operations:**
```bash
systemctl status offload-agent
journalctl -u offload-agent -f
systemctl restart offload-agent
systemctl stop offload-agent
```

### Web UI / GUI (interactive / single-node)

Opens a browser-based dashboard at `http://localhost:8080` for configuration, capability management, and log viewing.

**From source:**
```bash
cd offload-agent && make webui
```

**From Linux binary:**
```bash
offload-agent webui
```

**macOS app:** double-click `dist/Offload Agent.app` — tray icon appears; click → "Open Web UI".

**Windows exe:** run `offload-agent.exe` — tray icon appears in the system tray.

**macOS LaunchAgent (autostart, no Dock icon):**
```bash
"dist/Offload Agent.app/Contents/MacOS/Offload Agent" install launchd
# Installs ~/Library/LaunchAgents/com.offloadmq.agent.plist

launchctl load ~/Library/LaunchAgents/com.offloadmq.agent.plist
launchctl unload ~/Library/LaunchAgents/com.offloadmq.agent.plist
```

---

## Ansible Fleet Deployment

Role location: [ansible/roles/offload_agent/](ansible/roles/offload_agent/)

### Quick start

```bash
cp ansible/inventory/hosts.yml.example ansible/inventory/hosts.yml
# Edit hosts.yml — set server URL, API key, per-host capabilities

cd ansible
ansible-playbook playbooks/site.yml -i inventory/hosts.yml
```

The role runs three steps in order: **install binary → deploy custom skills → register with server → configure systemd service**.

### Install methods

**`release` (default)** — downloads the binary from GitHub releases:
```yaml
offload_agent_install_method: release
offload_agent_release_url: "https://github.com/AlexGrek/offloadmq/releases/latest/download/offload-agent-linux-amd64"
```

**`local`** — copies a binary you built on the Ansible controller:
```bash
cd offload-agent && make build   # must build on Linux for Linux targets

ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_install_method=local \
  -e offload_agent_local_binary=../offload-agent/dist/offload-agent
```

### Registration idempotency

The role re-registers an agent only when something changed:
- `server` or `apiKey` differs from the stored config
- `capabilities` list changed (sorted comparison)
- `offload_agent_force_register: true` is set

Force re-registration of all nodes:
```bash
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_force_register=true
```

### Common playbook patterns

```bash
# Stop fleet
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_service_state=stopped

# Binary upgrade (build locally, push, re-register)
cd offload-agent && make build
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_install_method=local \
  -e offload_agent_local_binary=../offload-agent/dist/offload-agent \
  -e offload_agent_force_register=true

# Update capabilities only (no binary change)
# Edit inventory capabilities lists, then:
ansible-playbook playbooks/site.yml -i inventory/hosts.yml
```

### Inventory structure

```yaml
# ansible/inventory/hosts.yml
all:
  vars:
    offload_agent_server: https://offloadmq.example.com
    offload_agent_api_key: "ak_live_..."

  children:
    gpu_agents:
      hosts:
        gpu-01:
          offload_agent_tier: 10
          offload_agent_capacity: 2
          offload_agent_capabilities:
            - "llm.qwen3:8b[vision;tools;8b]"
            - shell.bash
            - shellcmd.bash

    cpu_agents:
      hosts:
        worker-[01:10]:
          offload_agent_tier: 3
          offload_agent_capabilities:
            - shell.bash
            - shellcmd.bash
            - debug.echo
```

---

## Built-in Capabilities

| Capability | Requires | Notes |
|---|---|---|
| `debug.echo` | nothing | Returns payload as-is; useful for testing |
| `shell.bash` | bash | Executes arbitrary bash scripts |
| `shellcmd.bash` | bash | Executes shell commands |
| `tts.kokoro` | Kokoro TTS installed | Text-to-speech synthesis |
| `llm.<model>` | Ollama running + model pulled | e.g. `llm.qwen3:8b`, `llm.mistral` |
| `imggen.<backend>` | ComfyUI | Image generation |
| `docker.<image>` | Docker daemon | Runs tasks in containers |

Extended attribute notation (brackets) is metadata for management UI — the scheduler strips it for matching:
- `llm.qwen3:8b[vision;tools;8b]` registers as `llm.qwen3:8b`
- Clients always submit with base capability only: `"capability": "llm.qwen3:8b"`

**Tier-based scheduling:** When multiple agents share a capability, the server prefers higher-tier agents. GPU agents at tier 10 get all tasks when online; CPU agents at tier 3 only receive tasks when no GPU agent is available.

---

## Managing Capabilities

### Adding / changing capabilities via CLI

Re-registration is required any time the capability list changes:

```bash
# Register with specific capabilities
offload-agent cli register \
  --server https://offloadmq.example.com \
  --key ak_live_... \
  --caps shell.bash \
  --caps shellcmd.bash \
  --caps "llm.qwen3:8b[vision;tools;8b]"
  # Ollama models are auto-detected and merged in
```

`register` always creates a **new** agent identity on the server (new `agentId`). Old identity becomes stale and will time out.

### Adding / changing capabilities via Web UI

1. Open `http://localhost:8080`
2. **Capabilities** card → check/uncheck built-in capabilities
3. Click **Register** — triggers a fresh registration with the new list
4. The agent restarts its serve loop automatically

### Removing a capability

Remove it from the list and re-register:
```bash
# Via CLI: simply omit it from --caps
offload-agent cli register --server URL --key KEY --caps shell.bash

# Via Ansible: remove from inventory, run playbook
# Role detects capability mismatch and re-registers automatically
```

---

## Custom Capabilities (Skills)

Custom capabilities are YAML files that define either a **shell** executor (bash script) or an **llm** executor (Ollama prompt template).

**Storage location (priority order):**
1. `$OFFLOAD_CUSTOM_CAPS_DIR` environment variable
2. `~/.offload-agent/custom/` — canonical default
3. `~/.offload-agent/skills/` — backward-compatible legacy path
4. `CWD/custom/`

The agent discovers YAML files at runtime on every task dispatch — no restart needed after adding a file.

### Adding a custom capability

**Via CLI import:**
```bash
# Validate first
offload-agent custom validate /path/to/my-skill.yaml

# Import (copies to ~/.offload-agent/custom/)
offload-agent custom import /path/to/my-skill.yaml

# List all discovered custom caps
offload-agent custom list

# Export a cap's YAML to stdout
offload-agent custom export my-skill
```

**Via web UI:**
1. **Capabilities** card → **+ Add custom capability**
2. Paste the capability string (e.g. `custom.my-skill[param1;param2:int]`)
3. Click **Register**
4. Drop the YAML file into `~/.offload-agent/custom/` manually (the UI registers the cap string; the file provides the implementation)

**Manual (just drop the file):**
```bash
cp my-skill.yaml ~/.offload-agent/custom/
# Agent picks it up automatically — no restart needed
# Then re-register to expose it to the server:
offload-agent cli register --server URL --key KEY \
  --caps shell.bash --caps custom.my-skill
```

### Custom capability YAML format

```yaml
# Shell type — runs a bash script with params as CUSTOM_* env vars
name: deploy-app           # becomes capability: custom.deploy-app
type: shell
description: Deploy the application to an environment
script: |
  #!/bin/bash
  set -euo pipefail
  echo "Deploying $CUSTOM_BRANCH to $CUSTOM_ENV"
params:
  - name: branch
    type: string
    default: main
  - name: env
    type: string
    default: staging
  - name: dry_run
    type: bool
    default: "false"
timeout: 120
env:
  DEPLOY_KEY: /path/to/key   # static env vars merged into subprocess env
```

```yaml
# LLM type — renders a prompt template and calls local Ollama
name: summarize
type: llm
description: Summarize text
model: mistral:7b
prompt: |
  Summarize the following in {{style}} style:
  {{text}}
system: You are a helpful assistant.
temperature: 0.7
max_tokens: 512
params:
  - name: text
    type: text
  - name: style
    type: string
    default: concise
timeout: 60
```

**Supported param types:** `string`, `int`/`integer`, `float`/`number`/`double`, `bool`/`boolean`, `text` (multiline), `json`/`object`.

Shell params are injected as `CUSTOM_<NAME>` env vars — **never string-interpolated** into the script, so injection-safe even with untrusted values.

### Removing a custom capability

```bash
# Delete the YAML file
rm ~/.offload-agent/custom/my-skill.yaml

# Re-register without it
offload-agent cli register --server URL --key KEY --caps shell.bash
```

### Custom capabilities via Ansible

The Ansible role deploys YAML files and automatically derives + registers capability strings:

```yaml
# inventory/hosts.yml
  skill_agents:
    hosts:
      worker-01:
        offload_agent_capabilities:
          - shell.bash
        # Deploy individual skill files from the controller:
        offload_agent_skills:
          - skills/deploy-app.yaml
          - skills/db-backup.yaml
      worker-02:
        offload_agent_capabilities:
          - shell.bash
        # Or deploy an entire directory:
        offload_agent_skills_dir: skills/worker02/
```

The role parses the YAML on the controller, builds the full capability string (e.g. `custom.deploy-app[branch;env;dry_run:bool]`), and merges it into the registration payload. No need to list custom caps in `offload_agent_capabilities`.

Override the remote storage path (must match `OFFLOAD_CUSTOM_CAPS_DIR` if set):
```yaml
offload_agent_skills_path: "/opt/offload-agent/custom"
```

---

## Config File Reference

**Path:** `{workdir}/.offload-agent.json`
- Binary: workdir = `WorkingDirectory` in the systemd unit (default: `$HOME`)
- Source: workdir = `offload-agent/` directory (next to `offload-agent.py`)

```json
{
  "server": "https://offloadmq.example.com",
  "apiKey": "ak_live_...",
  "agentId": "01KM1C77TEQ996XEWA5RSZRDFG",
  "key": "30e72a63-e5ba-41e8-95fb-fac5d02ee401",
  "jwtToken": "eyJ...",
  "tokenExpiresIn": 1774472638,
  "capabilities": ["shell.bash", "custom.deploy-app"],
  "autostart": false
}
```

`agentId` + `key` are the persistent identity — stable across JWT refreshes. The JWT is ephemeral; the agent self-refreshes it on 403 without operator intervention.

---

## Ansible Role Variables (full list)

| Variable | Default | Description |
|---|---|---|
| `offload_agent_server` | `https://offloadmq.example.com` | Server URL (**required**) |
| `offload_agent_api_key` | `""` | Agent registration key (**required**) |
| `offload_agent_tier` | `5` | Scheduling priority 0-255 |
| `offload_agent_capacity` | `1` | Concurrent task slots |
| `offload_agent_capabilities` | `[debug.echo, shell.bash, shellcmd.bash]` | Built-in capabilities to register |
| `offload_agent_install_method` | `release` | `release` or `local` |
| `offload_agent_release_url` | GitHub latest | Binary download URL |
| `offload_agent_local_binary` | `""` | Controller path when `install_method=local` |
| `offload_agent_bin_path` | `/usr/local/bin/offload-agent` | Install destination on remote |
| `offload_agent_user` | `{{ ansible_user_id }}` | OS user for the service |
| `offload_agent_workdir` | `/home/{{ user }}` | Where config file lives |
| `offload_agent_use_websocket` | `false` | WebSocket mode instead of HTTP polling |
| `offload_agent_force_register` | `false` | Force re-registration regardless of state |
| `offload_agent_service_state` | `started` | `started` / `stopped` / `restarted` |
| `offload_agent_service_enabled` | `true` | Enable service on boot |
| `offload_agent_skills` | `[]` | List of skill YAML paths on the controller |
| `offload_agent_skills_dir` | `""` | Local directory of skill YAMLs to deploy |
| `offload_agent_skills_path` | `~/.offload-agent/custom` | Remote skill storage path |
