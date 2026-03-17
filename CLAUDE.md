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

### Python Agent
```bash
cd offload-agent
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
make clean-all           # Clean all build artifacts (cargo, offload-agent, frontend dist)
make rebuild-all         # Clean everything, rebuild both images, push, and helm install/upgrade
```

## Architecture

### Four API Surfaces

All APIs are defined in [src/main.rs](src/main.rs) with middleware-protected nested routes:

1. **Client API** (`/api/*`) - client API key in JSON body as `api_key` field
   - `POST /api/task/submit` - Submit task to queue
   - `POST /api/task/submit_blocking` - Submit urgent task and wait for result
   - `POST /api/task/poll/{cap}/{id}` - Poll task status

2. **Storage API** (`/api/storage/*`) - same client API key, passed via `X-API-Key` header
   (header is used because GET / DELETE / multipart endpoints have no JSON body)
   - `GET  /api/storage/limits` - bucket limits for this key (max count, size, TTL)
   - `GET  /api/storage/buckets` - list all buckets owned by this key → `{buckets: [{bucket_uid, created_at, file_count, used_bytes, remaining_bytes, tasks}]}`
   - `POST /api/storage/bucket/create` - create a bucket → `{bucket_uid}`
   - `POST /api/storage/bucket/{bucket_uid}/upload` - upload file (`multipart/form-data`, field `file`)
   - `GET  /api/storage/bucket/{bucket_uid}/stat` - file list + remaining space (no hashes)
   - `GET  /api/storage/bucket/{bucket_uid}/file/{file_uid}/hash` - SHA-256 digest (no download)
   - `DELETE /api/storage/bucket/{bucket_uid}/file/{file_uid}` - delete single file
   - `DELETE /api/storage/bucket/{bucket_uid}` - delete bucket and all its files

3. **Agent API** (`/private/agent/*`) - JWT auth via `Authorization: Bearer` header
   - `GET /private/agent/task/poll_urgent` - Poll urgent tasks
   - `GET /private/agent/task/poll` - Poll non-urgent tasks
   - `POST /private/agent/take/{cap}/{id}` - Claim a task
   - `POST /private/agent/task/resolve/{cap}/{id}` - Report task completion
   - `POST /private/agent/task/progress/{cap}/{id}` - Report progress

4. **Management API** (`/management/*`) - Token auth via `Authorization: Bearer` header
   - `GET /management/capabilities/list/online` - List base capabilities of online agents (stripped)
   - `GET /management/capabilities/list/online_ext` - List raw capabilities with extended attributes
   - Agent and task listing, API key management

### Extended Capability Attributes

Agents can register capabilities with extended metadata using bracket notation:
- **Base capability**: `"llm.qwen3:8b"`
- **Extended capability**: `"llm.qwen3:8b[vision;tools;8b]"`

Attributes are semicolon-separated strings inside brackets. Examples:
- `"llm.mistral[7b;quantized;fp16]"` — model size, quantization, precision
- `"vision[gpu;cuda12.1]"` — GPU support with CUDA version
- `"database[postgresql;replication]"` — database type and features

**Capability Matching:**
- Clients always submit tasks with **base capabilities only** (no brackets)
- Agent registration accepts **raw capabilities** (with or without brackets)
- Scheduler strips brackets when matching: `"llm.qwen3:8b[...]"` matches task requiring `"llm.qwen3:8b"`
- Client APIs (`/api/capabilities/online`, management `/capabilities/list/online`) return only base capabilities
- Management endpoint `/capabilities/list/online_ext` returns raw capabilities with extended attributes for inspection

### Key Data Flow

1. Agents register (`POST /agent/register`) with capabilities that may include extended attributes in brackets
2. Clients submit tasks with base capability only (no brackets)
3. Scheduler strips extended attributes and matches tasks to agents by base capability, tier, and capacity
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
- Agents periodically poll for tasks matching their capabilities (extended attributes are stripped for matching)
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
- Bucket metadata: [src/db/bucket_storage.rs](src/db/bucket_storage.rs)
- File store (opendal): [src/storage/mod.rs](src/storage/mod.rs)

### File Bucket System

Clients can create temporary buckets to stage files alongside task submissions.

**Design constraints (per API key):**
- Max buckets: 10 (configurable via `STORAGE_MAX_BUCKETS_PER_KEY`)
- Max size per bucket: 1 GiB (configurable via `STORAGE_BUCKET_SIZE_BYTES`)
- Bucket TTL: 24 hours (configurable via `STORAGE_BUCKET_TTL_MINUTES`)
- No file download endpoint — this is intentional to prevent use as a file exchange service
- SHA-256 digest is computed at upload time and stored in bucket metadata

**Bucket metadata** (`BucketMeta` / `FileMeta` in [src/db/bucket_storage.rs](src/db/bucket_storage.rs)):
- Stored in a separate Sled DB under `{DATABASE_ROOT_PATH}/buckets/`
- Each bucket is scoped to one client API key (ownership enforced on every request)
- Two Sled trees: `buckets` (uid → BucketMeta) and `owner_idx` (api_key|uid → uid)

**File storage backend** ([src/storage/mod.rs](src/storage/mod.rs)):
- Configured via `STORAGE_BACKEND` env var: `local` (default), `webdav`, or `s3`
- Backed by [Apache OpenDAL](https://opendal.apache.org/) — same interface regardless of backend
- Files stored at path `{bucket_uid}/{file_uid}` within the configured root

**Cleanup worker** (spawned in [src/main.rs](src/main.rs)):
- Runs on startup and every 3 hours
- Deletes files from the storage backend, then removes bucket metadata from Sled

### Core Types

- Models: [src/models.rs](src/models.rs) - Agent, AssignedTask, UnassignedTask
- API schemas: [src/schema.rs](src/schema.rs) - Request/response DTOs
- Auth middleware: [src/middleware/](src/middleware/)
- Utilities: [src/utils.rs](src/utils.rs) - `base_capability()` and `capability_attrs()` for parsing extended capabilities

## Configuration

Server reads from `.env` file:
- `SERVER_ADDRESS` - Host:port binding (default: 0.0.0.0:3069)
- `DATABASE_ROOT_PATH` - Sled database location
- `JWT_SECRET` - Secret for agent JWT tokens
- `AGENT_API_KEYS` - Comma-separated agent registration keys
- `CLIENT_API_KEYS` - Comma-separated client API keys
- `MGMT_TOKEN` - Management endpoint auth token

### Storage Configuration

- `STORAGE_BACKEND` - `local` (default), `webdav`, or `s3`
- `STORAGE_LOCAL_ROOT` - Root dir for local backend (default: `{DATABASE_ROOT_PATH}/file_storage`)
- `STORAGE_MAX_BUCKETS_PER_KEY` - Max buckets per client API key (default: `10`)
- `STORAGE_BUCKET_SIZE_BYTES` - Max bytes per bucket (default: `1073741824` = 1 GiB)
- `STORAGE_BUCKET_TTL_MINUTES` - Bucket lifetime in minutes (default: `1440` = 24 h)
- WebDAV: `STORAGE_WEBDAV_ENDPOINT`, `STORAGE_WEBDAV_USERNAME`, `STORAGE_WEBDAV_PASSWORD`
- S3: `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`, `STORAGE_S3_ENDPOINT`

## Tech Stack

- **Backend**: Rust with Axum 0.8, Tokio, Sled, jsonwebtoken
- **Agent**: Python 3 with requests, supports Ollama LLM integration
- **Frontend**: React 19 with Vite, framer-motion, lucide-react
- **Deployment**: Docker multi-stage build, Kubernetes via Helm
