---
name: fleet
description: Deployment and fleet management architect context. Use when working on Ansible roles, systemd services, agent binary packaging, registration API, or multi-node agent fleet orchestration.
---

# Fleet Management — Deployment & Operations

## System Topology

```
┌─────────────┐      HTTPS       ┌──────────────────┐
│  Client(s)  │ ───────────────► │  OffloadMQ Server │
└─────────────┘                  │  (Rust / Axum)    │
                                 │  Sled DB          │
┌─────────────┐      HTTPS       │                  │
│  Management │ ───────────────► │  /management/*   │
│  Frontend   │                  └────────┬─────────┘
└─────────────┘                           │
                                          │ /agent/register
                                          │ /agent/auth
                                          │ /private/agent/*
                           ┌──────────────┼──────────────┐
                           ▼              ▼              ▼
                      ┌─────────┐   ┌─────────┐   ┌─────────┐
                      │ Agent 1 │   │ Agent 2 │   │ Agent N │
                      │ (Linux) │   │ (Linux) │   │ (Linux) │
                      └─────────┘   └─────────┘   └─────────┘
```

Agents are stateless workers. Each registers with the server, gets a JWT, polls for tasks, executes, and reports results. Agents can be added or removed at any time.

---

## Agent Registration Flow (HTTP API)

This is the exact API the Ansible role calls. No CLI binary is needed for registration — it's pure HTTP.

### Step 1: Register

```
POST {server}/agent/register
Content-Type: application/json

{
  "capabilities": ["debug.echo", "shell.bash", "llm.qwen3:8b[vision;tools]"],
  "tier": 5,
  "capacity": 1,
  "apiKey": "ak_live_...",
  "appVersion": "ansible-managed"
}

Response 200:
{
  "agentId": "01KM1C77TEQ996XEWA5RSZRDFG",   // ULID
  "key": "30e72a63-e5ba-41e8-95fb-fac5d02ee401" // UUID — agent secret
}
```

### Step 2: Authenticate

```
POST {server}/agent/auth
Content-Type: application/json

{
  "agentId": "01KM1C77TEQ996XEWA5RSZRDFG",
  "key": "30e72a63-e5ba-41e8-95fb-fac5d02ee401"
}

Response 200:
{
  "token": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
  "expiresIn": 1774472638  // Unix timestamp
}
```

### Step 3: Serve

The agent binary uses the JWT from step 2 to poll:

```
GET {server}/private/agent/task/poll
Authorization: Bearer <jwt>
```

**JWT expiry recovery:** The agent's `serve_tasks()` loop catches 403 responses and automatically calls `_reauth_or_reregister()` ([offload-agent/app/core.py:78-119](offload-agent/app/core.py#L78-L119)), which:
1. Re-authenticates with existing `agentId`/`key` (handles expired JWT)
2. Falls back to full re-registration if the agent record was deleted from server
3. Writes the new JWT back to `.offload-agent.json`

**This means:** Ansible does NOT need to handle JWT refresh. Once the config has valid `agentId` and `key`, the agent binary self-heals.

---

## Agent Config File

**Path:** `{workdir}/.offload-agent.json` — the working directory matters.

```json
{
  "server": "https://offloadmq.example.com",
  "apiKey": "ak_live_...",
  "agentId": "01KM1C77TEQ996XEWA5RSZRDFG",
  "key": "30e72a63-e5ba-41e8-95fb-fac5d02ee401",
  "jwtToken": "eyJ...",
  "tokenExpiresIn": 1774472638,
  "capabilities": ["debug.echo", "shell.bash"],
  "autostart": false
}
```

| Field | Source | Mutable at runtime |
|---|---|---|
| `server`, `apiKey` | User config | No (Ansible-managed) |
| `agentId`, `key` | Registration response | No (stable across JWT refreshes) |
| `jwtToken`, `tokenExpiresIn` | Auth response | Yes (agent self-refreshes) |
| `capabilities` | User config | No (Ansible-managed) |
| `autostart` | UI toggle | Only for webui mode (irrelevant for headless) |

**Critical:** `agentId` + `key` are the persistent identity. The JWT is ephemeral. Re-registration creates a **new** agent identity on the server.

---

## Ansible Role — `ansible/roles/offload_agent/`

### Directory Layout

```
roles/offload_agent/
  defaults/main.yml           # all configurable variables with defaults
  tasks/
    main.yml                  # orchestrator: install → register → service
    install.yml               # binary: download from release or copy local
    register.yml              # idempotent registration via HTTP API
    service.yml               # systemd unit + enable + start
  templates/
    offload-agent.service.j2  # headless systemd unit (cli serve, no webui)
  handlers/main.yml           # daemon-reload + restart
```

### Key Variables

| Variable | Default | Description |
|---|---|---|
| `offload_agent_server` | (required) | OffloadMQ server URL |
| `offload_agent_api_key` | (required) | Agent registration API key |
| `offload_agent_capabilities` | `[debug.echo, shell.bash, shellcmd.bash]` | Capability list (with optional extended attrs in brackets) |
| `offload_agent_tier` | `5` | Scheduling priority (0-255, higher = preferred) |
| `offload_agent_capacity` | `1` | Concurrent task slots |
| `offload_agent_install_method` | `release` | `release` (GitHub download) or `local` (copy from controller) |
| `offload_agent_release_url` | GitHub latest | Binary download URL |
| `offload_agent_local_binary` | `""` | Controller-side path for `local` method |
| `offload_agent_bin_path` | `/usr/local/bin/offload-agent` | Install destination |
| `offload_agent_user` | `ansible_user_id` | System user for the service |
| `offload_agent_workdir` | `/home/{user}` | Where `.offload-agent.json` lives |
| `offload_agent_use_websocket` | `false` | WebSocket mode vs HTTP polling |
| `offload_agent_force_register` | `false` | Force re-registration |
| `offload_agent_service_state` | `started` | `started` / `stopped` / `restarted` |
| `offload_agent_service_enabled` | `true` | Enable on boot |

### Idempotency Logic (register.yml)

Registration is skipped when ALL of:
- Config file exists on the target
- `server` in config matches `offload_agent_server`
- `apiKey` in config matches `offload_agent_api_key`
- `capabilities` in config match `offload_agent_capabilities` (sorted comparison)
- `offload_agent_force_register` is false

When any of these differ → full re-registration (new agentId, key, JWT).

### Systemd Service (template)

```ini
[Unit]
Description=Offload Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={{ offload_agent_user }}
WorkingDirectory={{ offload_agent_workdir }}
ExecStart={{ offload_agent_bin_path }} cli serve{{ ' --ws' if offload_agent_use_websocket else '' }}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**No webui, no port, no sleep delay.** The `cli serve` command:
1. Reads config from `{workdir}/.offload-agent.json`
2. Authenticates (refreshes JWT if needed)
3. Enters infinite poll loop
4. Auto-recovers from 403 / network errors

---

## Inventory Patterns

### Per-host capabilities

```yaml
all:
  vars:
    offload_agent_server: https://offloadmq.alexgr.space
    offload_agent_api_key: "607255d4..."

  children:
    gpu_agents:
      hosts:
        gpu-01:
          offload_agent_tier: 10
          offload_agent_capabilities:
            - "llm.qwen3:8b[vision;tools;8b]"
            - shell.bash
    cpu_agents:
      hosts:
        worker-[01:10]:
          offload_agent_tier: 3
          offload_agent_capabilities:
            - shell.bash
            - shellcmd.bash
```

### Capability matching

Clients submit tasks with **base capabilities only** (no brackets):
```json
{ "capability": "llm.qwen3:8b" }
```

The scheduler strips brackets when matching: `llm.qwen3:8b[vision;tools;8b]` → matches `llm.qwen3:8b`.

Extended attributes in brackets are metadata for management UI inspection only.

---

## Binary Build & Distribution

### Build on the controller

```bash
cd offload-agent
make build    # → dist/offload-agent (PyInstaller single-file ELF)
```

Requires: Python 3.10+, Node.js (for frontend build), on a **Linux** host (binary is arch-specific).

### Deploy via Ansible

```bash
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_install_method=local \
  -e offload_agent_local_binary=../offload-agent/dist/offload-agent
```

### Deploy from GitHub release

```bash
ansible-playbook playbooks/site.yml -i inventory/hosts.yml
# uses offload_agent_install_method=release (default)
```

---

## Makefile Targets (`offload-agent/Makefile`)

For single-node manual deployment (no Ansible):

| Target | Description |
|---|---|
| `make install-systemd SERVER=... KEY=...` | Build + install binary + register + create systemd service |
| `make register-systemd SERVER=... KEY=...` | Register + create systemd service (binary already installed) |
| `make build` | Build the binary only (`dist/offload-agent`) |

These create a headless systemd service running `cli serve` (same as the Ansible role).

---

## Common Operations

### Rolling capability update

```bash
# Edit inventory with new capabilities, then:
ansible-playbook playbooks/site.yml -i inventory/hosts.yml
# Role detects capability mismatch → re-registers affected hosts
```

### Force re-registration of entire fleet

```bash
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_force_register=true
```

### Stop all agents

```bash
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_service_state=stopped
```

### Binary upgrade

```bash
cd offload-agent && make build
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_install_method=local \
  -e offload_agent_local_binary=../offload-agent/dist/offload-agent \
  -e offload_agent_force_register=true
```

---

## Tier-Based Scheduling (server side)

When multiple agents share a capability, the server's scheduler ([src/mq/scheduler.rs](src/mq/scheduler.rs)) assigns tasks to the **highest-tier online agents** first:

1. Find all online agents with the required capability
2. Determine the max tier among them
3. Skip the task for agents whose tier < max tier
4. Randomly select among eligible agents

**Example:** GPU agents at tier 10, CPU agents at tier 3. GPU agents get all tasks when online. CPU agents only receive tasks when no GPU agent is available.

An agent is considered **online** if its `last_contact` timestamp is < 120 seconds old (updated on every poll).
