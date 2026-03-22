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

### Custom Skills Variables

| Variable | Default | Description |
|---|---|---|
| `offload_agent_skills` | `[]` | List of skill YAML paths on the controller to deploy |
| `offload_agent_skills_dir` | `""` | Local directory; all `*.yaml`/`*.yml` files are deployed |
| `offload_agent_skills_path` | `~/.offload-agent/custom` | Remote directory where skills are stored |

Skills are deployed **before** registration. The role parses each YAML file on the controller, derives the full capability string (including typed parameter attributes), and automatically merges it into `offload_agent_capabilities` before calling the register API. If a `custom.<name>` entry is already present in `offload_agent_capabilities`, it is left untouched — letting you override the schema declaration manually.

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

### Deploy agents with custom skills

Put skill YAML files on the Ansible controller and reference them in your inventory:

```yaml
# inventory/hosts.yml
all:
  vars:
    offload_agent_server: https://offloadmq.example.com
    offload_agent_api_key: "YOUR_KEY"

  children:
    worker_agents:
      hosts:
        worker-01:
          offload_agent_capabilities:
            - debug.echo
            - shell.bash
          # Deploy individual skill files:
          offload_agent_skills:
            - skills/deploy-app.yaml
            - skills/db-backup.yaml
        worker-02:
          offload_agent_capabilities:
            - debug.echo
          # Deploy an entire skills directory:
          offload_agent_skills_dir: skills/worker02/
```

The role will:
1. Copy the YAML files to `~/.offload-agent/custom/` on each host
2. Parse the YAML to build the full capability string (e.g. `custom.deploy-app[branch;env]`)
3. Register it with the server automatically — no need to list it in `offload_agent_capabilities`

**Skill YAML example** (`skills/deploy-app.yaml` on the controller):

```yaml
name: deploy-app
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
```

### Re-deploy skills only (without reinstalling binary)

```bash
ansible-playbook playbooks/site.yml -i inventory/hosts.yml \
  --tags skills
```

> **Note:** tag the skills tasks by adding `tags: skills` to the `import_tasks: skills.yml` line in `tasks/main.yml` if you want this shortcut.
