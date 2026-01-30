# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OffloadMQ is a distributed task queue system for offloading computational tasks to remote agent nodes. It follows a client-server-agent architecture where clients submit tasks, the server orchestrates distribution, and agents execute tasks.

## Development Commands

### Rust Backend (Message Queue Server)
```bash
make dev-mq              # Run the server (cargo run)
cargo build              # Build release
cargo test               # Run Rust unit tests
```

### Python Agent Client
```bash
cd offload-client
make venv                # Create virtualenv and install dependencies
make serve               # Register agent and start serving (requires running server)
make register            # Register agent only
```

### React Management Frontend
```bash
cd management-frontend
npm install              # Install dependencies
npm run dev              # Start dev server
npm run build            # Production build
npm run lint             # Run ESLint
```

### Integration Tests
```bash
# From project root:
make test-full           # Full test: start server+agent, run tests, stop everything
make test-unit           # Run Rust unit tests only
make test                # Run integration tests (requires running server+agent)
make test-start          # Start server and agent for manual testing
make test-stop           # Stop server and agent
make test-logs           # Show server and agent logs

# From itests directory:
cd itests
make venv                # Setup test environment
make test-full           # Full automated test run
make start-server        # Start server in background
make start-agent         # Start agent in background (starts server if needed)
make stop-all            # Stop server and agent
make logs                # Show logs
make run                 # Run pytest (server+agent must be running)
```

### Docker/Kubernetes Deployment
```bash
make build               # Build container image
make push                # Push to registry
make deploy              # Build, push, and helm install/upgrade
make template            # Preview helm manifests
```

## Architecture

### Three API Surfaces

All APIs are defined in [src/main.rs](src/main.rs) with middleware-protected nested routes:

1. **Client API** (`/api/*`) - API key auth via `X-API-Key` header
   - `POST /api/task/submit` - Submit task to queue
   - `POST /api/task/submit_blocking` - Submit urgent task and wait for result
   - `POST /api/task/poll/{cap}/{id}` - Poll task status

2. **Agent API** (`/private/agent/*`) - JWT auth via `Authorization: Bearer` header
   - `GET /private/agent/task/poll_urgent` - Poll urgent tasks
   - `GET /private/agent/task/poll` - Poll non-urgent tasks
   - `POST /private/agent/take/{cap}/{id}` - Claim a task
   - `POST /private/agent/task/resolve/{cap}/{id}` - Report task completion
   - `POST /private/agent/task/progress/{cap}/{id}` - Report progress

3. **Management API** (`/management/*`) - Token auth via `X-Mgmt-Token` header
   - Agent and task listing, API key management

### Key Data Flow

1. Agents register (`POST /agent/register`) and authenticate (`POST /agent/auth`) to get JWT
2. Clients submit tasks with a required `capability` field
3. Scheduler matches tasks to online agents by capability, tier, and capacity
4. Urgent tasks use in-memory store with 60s TTL; regular tasks persist to Sled DB

### Storage Layer

- **Sled DB** ([src/db/](src/db/)) - Embedded key-value store for persistent data
- **LRU Cache** - In-memory agent cache with 120s online timeout
- Agent storage: [src/db/agent.rs](src/db/agent.rs)
- Task storage: [src/db/persistent_task_storage.rs](src/db/persistent_task_storage.rs)
- Urgent queue: [src/mq/urgent.rs](src/mq/urgent.rs)

### Core Types

- Models: [src/models.rs](src/models.rs) - Agent, AssignedTask, UnassignedTask
- API schemas: [src/schema.rs](src/schema.rs) - Request/response DTOs
- Auth middleware: [src/middleware/](src/middleware/)

## Configuration

Server reads from `.env` file:
- `SERVER_ADDRESS` - Host:port binding (default: 0.0.0.0:3069)
- `DATABASE_ROOT_PATH` - Sled database location
- `JWT_SECRET` - Secret for agent JWT tokens
- `AGENT_API_KEYS` - Comma-separated agent registration keys
- `CLIENT_API_KEYS` - Comma-separated client API keys
- `MGMT_TOKEN` - Management endpoint auth token

## Tech Stack

- **Backend**: Rust with Axum 0.8, Tokio, Sled, jsonwebtoken
- **Agent**: Python 3 with requests, supports Ollama LLM integration
- **Frontend**: React 19 with Vite, framer-motion, lucide-react
- **Deployment**: Docker multi-stage build, Kubernetes via Helm
