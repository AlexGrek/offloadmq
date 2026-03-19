# Ansible — OffloadMQ Agent Fleet Management

Ansible role for declarative deployment and management of offload-agent nodes.

## Quick Start

```bash
# 1. Copy and edit inventory
cp inventory/hosts.yml.example inventory/hosts.yml

# 2. Deploy all agents
ansible-playbook playbooks/site.yml -i inventory/hosts.yml
```

## What it does

1. **Installs** the agent binary (downloads from GitHub release or copies a local build)
2. **Registers** the agent with the server via the HTTP API (idempotent — skips if already registered with matching server/key)
3. **Creates** a systemd service running `offload-agent cli serve` (headless, no web UI, no open port)
4. **Starts** and enables the service

## Role Variables

| Variable | Default | Description |
|---|---|---|
| `offload_agent_server` | `https://offloadmq.example.com` | Server URL |
| `offload_agent_api_key` | `""` | Agent registration API key (**required**) |
| `offload_agent_tier` | `5` | Performance tier (0-255) |
| `offload_agent_capacity` | `1` | Concurrent task slots |
| `offload_agent_capabilities` | `[debug.echo, shell.bash, shellcmd.bash]` | Capability list |
| `offload_agent_install_method` | `release` | `release` (download) or `local` (copy from controller) |
| `offload_agent_release_url` | GitHub latest | URL to download the binary |
| `offload_agent_local_binary` | `""` | Path on controller (when `install_method=local`) |
| `offload_agent_bin_path` | `/usr/local/bin/offload-agent` | Where to install the binary |
| `offload_agent_user` | `{{ ansible_user_id }}` | System user to run the service as |
| `offload_agent_workdir` | `/home/{{ user }}` | Working directory (config file lives here) |
| `offload_agent_use_websocket` | `false` | Use WebSocket mode instead of polling |
| `offload_agent_force_register` | `false` | Force re-registration even if config exists |
| `offload_agent_service_state` | `started` | `started`, `stopped`, or `restarted` |
| `offload_agent_service_enabled` | `true` | Enable service on boot |

## Examples

### Deploy with a locally-built binary

```bash
cd offload-agent && make build
cd ../ansible

ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_install_method=local \
  -e offload_agent_local_binary=../offload-agent/dist/offload-agent
```

### Re-register all agents (e.g. after capability changes)

```bash
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_force_register=true
```

### Stop the fleet

```bash
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  -e offload_agent_service_state=stopped
```
