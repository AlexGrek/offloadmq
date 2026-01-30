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

### Task Scheduling Logic

#### Urgent vs Non-Urgent Tasks

| Aspect               | Urgent                                                    | Non-Urgent                                                                                  |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Storage**          | In-memory IndexMap ([src/mq/urgent.rs](src/mq/urgent.rs)) | Sled persistent DB ([src/db/persistent_task_storage.rs](src/db/persistent_task_storage.rs)) |
| **TTL**              | 60 seconds (auto-expires)                                 | No TTL (archived after 7 days)                                                              |
| **Client Blocking**  | Yes - `/submit_blocking` waits for result                 | No - `/submit` returns immediately with task ID                                             |
| **Tier Filtering**   | None (FIFO)                                               | Higher-tier agents get priority                                                             |
| **Polling Endpoint** | `GET /private/agent/task/poll_urgent`                     | `GET /private/agent/task/poll` (checks urgent first)                                        |

#### Submission Flow

**Urgent Tasks** ([src/api/client/mod.rs](src/api/client/mod.rs) lines 21-44):
1. Client calls `POST /api/task/submit_blocking`
2. Task stored in memory with `tokio::sync::watch` channel for status notifications
3. Client connection blocks waiting for completion
4. Background expiration task removes stale tasks every 10 seconds

**Non-Urgent Tasks** ([src/api/client/mod.rs](src/api/client/mod.rs) lines 46-77):
1. Client calls `POST /api/task/submit`
2. Task persisted to Sled DB `tasks_unassigned` tree
3. Returns immediately with task ID and "pending" status

#### Agent Polling & Assignment

**Polling** ([src/api/agent/mod.rs](src/api/agent/mod.rs)):
- Agents periodically poll for tasks matching their capabilities
- Non-urgent polling always checks urgent queue first (line 49)
- Updates agent's `last_contact` timestamp (online if < 120 seconds ago)

**Tier-Based Scheduling** ([src/mq/scheduler.rs](src/mq/scheduler.rs) lines 20-46):
```
For each non-urgent task matching capability:
  1. Find all ONLINE agents with same capability
  2. Get MAX tier among those agents
  3. If requesting agent's tier < max tier:
     - Skip task (reserve for higher-tier agents)
  4. Else:
     - Include task in available pool
  5. Randomly select from eligible tasks
```
This ensures high-performance agents get priority while lower-tier agents still receive tasks when no higher-tier agents are online.

**Task Pickup** ([src/api/agent/mod.rs](src/api/agent/mod.rs) lines 130-145):
1. Agent calls `POST /private/agent/take/{cap}/{id}`
2. Task atomically moved from unassigned → assigned state
3. For urgent tasks: status updated via watch channel notifies waiting client

#### Task Resolution

**Progress Updates**: `POST /private/agent/task/progress/{cap}/{id}` - appends logs and stage info
**Completion**: `POST /private/agent/task/resolve/{cap}/{id}` - sets final status (Completed/Failed)

For urgent tasks, resolution triggers the watch channel to unblock the waiting client and return the result.

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
