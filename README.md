# 🚀 OffloadMQ

A distributed task queue system for offloading computational tasks to remote agent nodes. Follows a client-server-agent architecture: clients submit tasks, the server orchestrates distribution, and agents execute them.

## ⚡ Quick Install

Download the latest offload-agent binary:

```bash
# macOS (Apple Silicon)
curl -LO "https://dl.alexgr.space/rs/offload-agent/latest/darwin-arm64/offload-agent-darwin-arm64"
chmod +x offload-agent-darwin-arm64

# Linux (x86_64)
curl -LO "https://dl.alexgr.space/rs/offload-agent/latest/linux-amd64/offload-agent-linux-amd64"
chmod +x offload-agent-linux-amd64
```

### Self-install

The binary can install itself onto the system:

```bash
# Copy binary to system path (destination is optional)
offload-agent install bin [--dest DIR]

# Linux — install and enable as a systemd service
offload-agent install systemd [--bin-path PATH] [--user USER] [--host HOST] [--port PORT]
# Note: auto-detects the real user when run with sudo

# macOS — install as a launchd service
offload-agent install launchd [--app-path PATH]
```

> Windows installer is not yet available.

## 🐳 Single-Node Setup

Spin up a complete local stack — backend, agent with web UI, and management frontend — in one command. Zero configuration required.

```bash
docker compose up --build
```

| Service | URL | Description |
|---------|-----|-------------|
| OffloadMQ backend | `http://localhost:3069` | Task queue server |
| Agent web UI | `http://localhost:8081` | Agent dashboard (auto-registered) |
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
make dev-mq          # cargo run
cargo test           # unit tests
```

### ⚙️ Agent
```bash
make dev-agent       # register and start serving (requires running server)
```

### 🎨 Frontend
```bash
make dev-frontend    # npm run dev (Vite dev server at http://localhost:5173)
```

### 🧪 Integration Tests
```bash
make test-full       # start server + agent, run tests, stop everything
make test-start      # start server + agent in background
make test            # run tests (server + agent must be running)
make test-stop       # stop server + agent
make test-logs       # tail logs
```

## ☸️ Kubernetes Deployment

### 📋 Prerequisites

- `kubectl` configured against your cluster
- `helm` 3.x
- `docker` (or another container runtime)

### 1️⃣ Generate secrets

Creates `.secrets.yaml` with randomly generated values in Helm values format. The secret is created once on first install and never overwritten by subsequent upgrades — keys persist across redeploys.

```bash
make secrets
```

This file is used by `install` and `upgrade`. Keep it safe and out of version control — it is already in `.gitignore`.

To regenerate (overwrites existing file):
```bash
make secrets-force
```

### 2️⃣ Build and push the image

```bash
make build push
```

The image tag defaults to the current `git describe` output. Override with:

```bash
make build push TAG=1.2.3
```

For multi-platform builds (pushes directly to the registry):
```bash
make build-multiplatform TAG=1.2.3
```

### 3️⃣ Install

```bash
make install
```

Equivalent helm command:
```bash
helm install offloadmq offloadmq-chart \
  --namespace offloadmq --create-namespace \
  --set image.tag=<TAG> \
  -f .secrets.yaml
```

### 4️⃣ Upgrade

After rebuilding and pushing a new image:

```bash
make upgrade
```

Or do it all in one step (build → push → install-or-upgrade):

```bash
make deploy
```

Multi-platform variant:
```bash
make deploy-multiplatform
```

### 5️⃣ Other helm commands

| Command          | Description                                 |
| ---------------- | ------------------------------------------- |
| `make template`  | Render manifests to stdout without applying |
| `make status`    | Show helm release status                    |
| `make uninstall` | Remove the release (data PVC is retained)   |

### 🎛️ Management UI

The management frontend is deployed as a sidecar in the same pod, enabled by default. It is available at:

```
https://<your-host>/ui
```

To disable it:
```bash
make install   # first install
# or
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
