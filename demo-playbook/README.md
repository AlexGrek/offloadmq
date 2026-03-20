# Demo Playbook — Provision OffloadMQ Agent

This directory contains a minimal Ansible playbook to provision the OffloadMQ agent on a single host.

## Quick Start

### 1. Update Configuration

Edit `inventory.yml` to match your environment:

```yaml
offload_agent_server: https://your-offloadmq-server:3069
offload_agent_api_key: "your-agent-api-key"
```

Update the target host IP/hostname if needed:
```yaml
demo-agent-01:
  ansible_host: 192.168.69.192
  ansible_user: root
```

### 2. Run the Playbook

```bash
cd demo-playbook
ansible-playbook playbook.yml -i inventory.yml
```

Or with verbose output:
```bash
ansible-playbook playbook.yml -i inventory.yml -v
```

### 3. Verify

SSH to the host and check the agent status:

```bash
ssh 192.168.69.192
systemctl status offload-agent
journalctl -u offload-agent -f
```

You should see the agent polling the server and ready to accept tasks.

## What Gets Deployed

The playbook:
1. **Downloads** the offload-agent binary from GitHub releases (or copies a local binary)
2. **Registers** the agent with the OffloadMQ server via HTTP API
3. **Creates** a systemd service (`offload-agent.service`)
4. **Starts** the service and enables it for boot

The agent runs as a headless daemon (`cli serve`) that:
- Polls the server for tasks matching its capabilities
- Executes tasks and reports results
- Auto-refreshes JWT tokens (no manual intervention needed)

## Configuration

All variables are defined in `inventory.yml` or can be passed via `-e`:

| Variable | Default | Description |
|---|---|---|
| `offload_agent_server` | (required) | OffloadMQ server URL |
| `offload_agent_api_key` | (required) | Agent registration key |
| `offload_agent_tier` | `5` | Scheduling tier (0-255, higher = preferred) |
| `offload_agent_capacity` | `1` | Concurrent task slots |
| `offload_agent_capabilities` | `[debug.echo, shell.bash, shellcmd.bash]` | Capability list |
| `offload_agent_install_method` | `release` | `release` or `local` |

## Per-Host Customization

Override variables in `inventory.yml` for specific hosts:

```yaml
demo_agents:
  hosts:
    demo-agent-01:
      ansible_host: 192.168.69.192
      offload_agent_tier: 10  # high-tier agent
      offload_agent_capacity: 4  # handle multiple tasks
      offload_agent_capabilities:
        - debug.echo
        - shell.bash
        - llm.qwen3:8b[vision;tools]
```

## Common Tasks

### Force Re-registration

```bash
ansible-playbook playbook.yml -i inventory.yml -e offload_agent_force_register=true
```

### Stop the Agent

```bash
ansible-playbook playbook.yml -i inventory.yml -e offload_agent_service_state=stopped
```

### Use a Local Binary

Build the binary locally:
```bash
cd offload-agent
make build  # → dist/offload-agent
```

Deploy it:
```bash
cd demo-playbook
ansible-playbook playbook.yml -i inventory.yml \
  -e offload_agent_install_method=local \
  -e offload_agent_local_binary=../offload-agent/dist/offload-agent
```

### Update Capabilities After Deployment

Edit `inventory.yml`, change `offload_agent_capabilities`, then re-run:
```bash
ansible-playbook playbook.yml -i inventory.yml
```

The role detects the change and re-registers the agent automatically.

## References

- Full Ansible role documentation: [ansible/README.md](../ansible/README.md)
- Agent API & registration flow: [docs/tasks-api.md](../docs/tasks-api.md#agent-api)
- Agent config file: [offload-agent/app/config.py](../offload-agent/app/config.py)
