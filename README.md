# OffloadMQ

A distributed task queue system for offloading computational tasks to remote agent nodes. Follows a client-server-agent architecture: clients submit tasks, the server orchestrates distribution, and agents execute them.

## Architecture

- **Server** — Rust/Axum HTTP server with a persistent Sled DB and in-memory urgent queue
- **Agent** — Python worker that registers with the server and executes tasks
- **Frontend** — React management UI (served at `/ui` when deployed)

## Local Development

### Server
```bash
make dev-mq          # cargo run
cargo test           # unit tests
```

### Agent
```bash
make dev-agent       # register and start serving (requires running server)
```

### Frontend
```bash
make dev-frontend    # npm run dev (Vite dev server at http://localhost:5173)
```

### Integration tests
```bash
make test-full       # start server + agent, run tests, stop everything
make test-start      # start server + agent in background
make test            # run tests (server + agent must be running)
make test-stop       # stop server + agent
make test-logs       # tail logs
```

## Kubernetes Deployment

### Prerequisites

- `kubectl` configured against your cluster
- `helm` 3.x
- `docker` (or another container runtime)

### 1. Generate secrets

Creates `.secrets.yaml` with a randomly generated Kubernetes Secret manifest:

```bash
make secrets
```

This file is used by `install` and `upgrade`. Keep it safe and out of version control — it is already in `.gitignore`.

To regenerate (overwrites existing file):
```bash
make secrets-force
```

### 2. Build and push the image

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

### 3. Install

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

### 4. Upgrade

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

### 5. Other helm commands

| Command | Description |
|---|---|
| `make template` | Render manifests to stdout without applying |
| `make status` | Show helm release status |
| `make uninstall` | Remove the release (data PVC is retained) |

### Management UI

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

### Configuration

Key `values.yaml` options (override with `--set` or a custom values file):

| Key | Default | Description |
|---|---|---|
| `image.repository` | `grekodocker/offloadmq` | Server image |
| `image.tag` | `latest` | Image tag |
| `ingress.hosts[0].host` | `offloadmq.alexgr.space` | Public hostname |
| `frontend.enabled` | `true` | Deploy management UI sidecar |
| `frontend.image.repository` | `grekodocker/offloadmq-frontend` | Frontend image |
| `frontend.image.tag` | `latest` | Frontend image tag |
| `persistence.size` | `1Gi` | PVC size for Sled DB |

Secrets (managed via `.secrets.yaml`, not `values.yaml`):

| Key | Description |
|---|---|
| `JWT_SECRET` | Signs agent JWT tokens |
| `CLIENT_API_KEYS` | Comma-separated client API keys (`X-API-Key` header) |
| `AGENT_API_KEYS` | Comma-separated agent registration keys |
| `MGMT_TOKEN` | Management endpoint auth token (`X-Mgmt-Token` header) |
