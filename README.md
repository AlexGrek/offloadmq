# 🚀 OffloadMQ

A distributed task queue system for offloading computational tasks to remote agent nodes. Follows a client-server-agent architecture: clients submit tasks, the server orchestrates distribution, and agents execute them.

## ⚡ Quick Install

Download the latest agent build — `omq` (headless CLI) or `omq-gui` (desktop app):

```bash
# macOS (Apple Silicon)
curl -LO "https://dl.alexgr.space/rs/offload-agent/latest/darwin-arm64/omq-gui-darwin-arm64"
chmod +x omq-gui-darwin-arm64

# Linux (x86_64)
curl -LO "https://dl.alexgr.space/rs/offload-agent/latest/linux-amd64/omq-linux-amd64"
chmod +x omq-linux-amd64
```

Point it at a server and start it:

```bash
omq config set --server https://<offloadmq-host> --api-key <agent key>
omq register
omq serve              # headless; or `omq webui --start` for the dashboard
```

On Linux, the dashboard's **System** page installs a systemd user service
(`offloadmq-agent.service`) that keeps the agent running and lets it update
itself. From a repo checkout, `task agent:update:linux` / `task agent:update:mac`
installs or upgrades the latest build in place.

## 🐳 Single-Node Setup

Spin up the backend and management frontend in one command. Zero configuration required — then attach agents with `omq` (see above) using the agent key from `docker-compose.yml`.

```bash
docker compose up
```

| Service | URL | Description |
|---------|-----|-------------|
| OffloadMQ backend | `http://localhost:3069` | Task queue server |
| Management UI | `http://localhost:8080/ui` | Fleet management frontend |

**Client API key:** `client_secret_key_123`

```bash
curl -X POST http://localhost:3069/api/task/submit \
  -H "Authorization: Bearer client_secret_key_123" \
  -H "Content-Type: application/json" \
  -d '{"capability": "debug.echo", "payload": {"message": "hello"}}'
```

> The default keys are for local use only. Change `JWT_SECRET`, `MGMT_TOKEN`, and all API keys in `docker-compose.yml` before exposing to a network.

## 🏗️ Architecture

- **🖥️ Server** — Rust/Axum HTTP server with a persistent Sled DB and in-memory urgent queue
- **⚙️ Agent** — Python worker that registers with the server and executes tasks
- **🎨 Frontend** — React management UI (served at `/ui` when deployed)

## 💻 Local Development

### 🖥️ Server
```bash
task dev             # cargo run
task test:unit       # unit tests
```

### ⚙️ Agent
```bash
task dev:agent       # start agent_v2 headless (configure + register first: see agent_v2/)
```

### 🎨 Frontend
```bash
task dev:frontend    # npm run dev (Vite dev server at http://localhost:5173)
```

### 🧪 Integration Tests
```bash
task test:full       # start server + agent, run tests, stop everything
task test:start      # start server + agent in background
task test            # run tests (server + agent must be running)
task test:stop       # stop server + agent
task test:logs       # tail logs
```

### 🎭 E2E Tests (Playwright)

**OAI Frontend (MANDATORY before committing OAI changes)**
```bash
# Requires `task dev` to be running first
cd oai/e2e
npm test             # Run Playwright tests
npm run test:ui      # Run with Playwright UI
```

**Management Frontend**
```bash
# Requires `task dev:frontend` (or similar) to be running first
cd management-frontend/e2e
npm test             # Run Playwright tests
npm run test:ui      # Run with Playwright UI
```

## ☸️ Kubernetes Deployment

### 📋 Prerequisites

- `kubectl` configured against your cluster
- `helm` 3.x
- `docker` (or another container runtime)

### 1️⃣ Generate secrets

Creates `.secrets.yaml` with randomly generated values in Helm values format. The secret is created once on first install and never overwritten by subsequent upgrades — keys persist across redeploys.

```bash
task secrets
```

This file is used by `deploy`. Keep it safe and out of version control — it is already in `.gitignore`.

To regenerate (overwrites existing file):
```bash
task secrets:force
```

### 2️⃣ Build, push, and deploy

```bash
task ship
```

This builds the backend and frontend Docker images, pushes them to the registry, pre-pulls on cluster nodes, then installs or upgrades the Helm release automatically.

The image tag defaults to `git rev-list --count HEAD`. Override with:

```bash
task ship TAG=1234
```

For a multi-platform backend build:
```bash
task docker:release:multi
task ship
```

### 3️⃣ Other helm commands

| Command           | Description                                      |
| ----------------- | ------------------------------------------------ |
| `task template`   | Render manifests to stdout without applying      |
| `task diff`       | Diff deployed vs local chart (helm-diff plugin)  |
| `task status`     | Show helm release status                         |
| `task rollback`   | Rollback to previous revision                    |
| `task undeploy`   | Remove the release (data PVC is retained)        |

### 🎛️ Management UI

The management frontend is deployed as a sidecar in the same pod, enabled by default. It is available at:

```
https://<your-host>/ui
```

To disable it:
```bash
helm upgrade offloadmq offloadmq-chart \
  --namespace offloadmq \
  --set frontend.enabled=false \
  -f .secrets.yaml
```

### ⚙️ Configuration

Key `values.yaml` options (override with `--set` or a custom values file):

| Key                         | Default                                     | Description                  |
| --------------------------- | ------------------------------------------- | ---------------------------- |
| `image.repository`          | `grekodocker/offloadmq`                     | Server image                 |
| `image.tag`                 | `latest`                                    | Image tag                    |
| `ingress.hosts[0].host`     | `offloadmq.alexgr.space`                    | Public hostname              |
| `frontend.enabled`          | `true`                                      | Deploy management UI sidecar |
| `frontend.image.repository` | `grekodocker/offloadmq-management-frontend` | Frontend image               |
| `frontend.image.tag`        | `latest`                                    | Frontend image tag           |
| `persistence.size`          | `1Gi`                                       | PVC size for Sled DB         |

🔐 Secrets (managed via `.secrets.yaml`, not `values.yaml`):

| Key               | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `JWT_SECRET`      | Signs agent JWT tokens                                 |
| `CLIENT_API_KEYS` | Comma-separated client API keys (`X-API-Key` header)   |
| `AGENT_API_KEYS`  | Comma-separated agent registration keys                |
| `MGMT_TOKEN`      | Management endpoint auth token (`X-Mgmt-Token` header) |
