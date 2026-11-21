# Repository guidance

OffloadMQ is a client/server/agent task queue. Its Rust MQ server, Python agent,
management UI/CLI, and OAI application are separate surfaces. Choose the owning
surface before changing code.

## Start here

- Use Go Task: `task --list` in the relevant directory. Root, `agent_v2/`, and
  `oai/` have separate Taskfiles. Only `itests/` uses Make.
- Read all matching skills **before implementation**, most specific first, then
  parent skills. Canonical skills live in [.agents/skills/](.agents/skills/).
  Detailed file maps and feature workflows belong in skills, not this file.
- For cross-surface symptoms (stuck tasks, missing progress/poll fields/results),
  start with [debug-stack](.agents/skills/debug-stack/SKILL.md).
- Preserve the required pre-commit checks below. Report checks that could not run
  and why.

## Skill routing

Read every matching skill; links below point to `SKILL.md`.

| Area / trigger | Skill |
| --- | --- |
| Any `agent_v2/**` work | [agent-v2](.agents/skills/agent-v2/SKILL.md) |
| Any `oai/backend/**` work | [oai-backend](.agents/skills/oai-backend/SKILL.md) |
| Any `oai/frontend/**` work | [oai-frontend](.agents/skills/oai-frontend/SKILL.md) |
| OAI Helm, Docker, Compose, deployment/infra Taskfile changes | [oai-devops](.agents/skills/oai-devops/SKILL.md) |
| `oai/itests/**` | [oai-itests](.agents/skills/oai-itests/SKILL.md) + feature under test |
| Chat, WS chat, system prompts, WorkloadContext, chat tasks/debug | [oai-chat](.agents/skills/oai-chat/SKILL.md) |
| Image generation, files/buckets, promptgen, image jobs/pipeline, ProgressContext | [oai-img](.agents/skills/oai-img/SKILL.md) |
| Image Tools: ImgUtilsPage, img_utils, image_resize, agent imgutils executor/workflows/autowiring | [oai-img-tools](.agents/skills/oai-img-tools/SKILL.md) |
| Movie Studio page/components/API/WS, movie services/jobs, ffmpeg | [oai-movie](.agents/skills/oai-movie/SKILL.md) |
| Image Cycles: image_cycles*, image_cycle_jobs, ImageCyclesPage, api/imageCycles.ts | [oai-image-cycles](.agents/skills/oai-image-cycles/SKILL.md) |
| Generator Improver page or quality/JSON/img2img branches of Image Cycles | [oai-generator-improver](.agents/skills/oai-generator-improver/SKILL.md) |
| LangGraph editors, runtime, dependencies, history/artifacts | [oai-langgraph](.agents/skills/oai-langgraph/SKILL.md) |
| Personas, persona chats/photos, persona prompt tokens | [oai-personas](.agents/skills/oai-personas/SKILL.md) |
| VR Worlds, image-to-splat jobs, headset links/WebXR viewer | [oai-worlds](.agents/skills/oai-worlds/SKILL.md) |
| OAI MCP tools, OAuth, connector auth, prompt expansion | [oai-mcp](.agents/skills/oai-mcp/SKILL.md) |
| `oai/cli/**` Go client | [oai-cli](.agents/skills/oai-cli/SKILL.md) |
| New OAI app backed by OffloadMQ jobs | [oai-new-feature](.agents/skills/oai-new-feature/SKILL.md); add documentation |
| Management UI sandbox apps, DevPanel, SandboxApps | [sandbox-apps](.agents/skills/sandbox-apps/SKILL.md) |

Feature skills stack with backend/frontend skills for the files touched. Agent-side
Image Tools also require `agent-v2`. Deploy-only work needs `oai-devops`; load
feature skills when application code also changes. Shared ToolDebugModal and
GlobalProgressDrawer require chat and/or image skills for the rows changed.
Keep image generation (`oai-img`) distinct from Image Tools (`oai-img-tools`).
For shared Image Cycles/Generator Improver changes, load both affected feature skills.

## Development and validation

Commands run from the directory in the first column. `cargo build` is a debug
build; use `cargo build --release` for release binaries.

| Directory | Setup / run | Validation |
| --- | --- | --- |
| Root (Rust MQ) | `task dev` | `task test:unit` (`cargo test`); `cargo build` |
| `agent_v2/` | `task install`; `task dev` (web UI) or `uv run omq serve` (headless) | **`task typecheck` mandatory before commit**; `uv run --with pytest pytest tests` |
| `management-frontend/` | `npm install`; `npm run dev` | `npm run build`; `npm run lint` |
| `management-frontend/e2e/` | Start dev server first | `npm test` (Playwright); `npm run test:ui` |
| `offloadmq-cli/` (separate Rust crate) | `cargo build --release` | `cargo fmt --check`; `cargo test`; `cargo clippy -- -D warnings` |
| `oai/` | `task install`; `task dev` (infra + backend + Vite) | `task build`; `task itest` (live backend integration tests) |
| `oai/e2e/` | Start OAI backend + frontend first | **`npm test` mandatory before committing OAI changes**; `npm run test:ui` |

OAI dev uses backend port **3001** and Vite port **5174**
([oai/Taskfile.yml](oai/Taskfile.yml)); the standalone backend defaults to 3000.
`task dev` requires vips CLI and ffmpeg. From `oai/`: `task infra:up`,
`task infra:down` (keeps volumes), `task infra:destroy` (deletes volumes),
`task kill` (stops dev ports and infrastructure).

MQ integration tests, from root: `task test:full` starts server/agent, tests, and
stops them; `task test` uses a running stack. Manual lifecycle: `task test:start`,
`task test:logs`, `task test:stop`. Underlying Make commands are in
[itests/Makefile](itests/Makefile); see [docs/testing.md](docs/testing.md).

Agent settings: `~/.offloadmq-agent.json`. From `agent_v2/`:

```sh
uv run omq config set --server http://localhost:3069 --api-key <agent-key>
uv run omq register
uv run omq serve
```

`omqcli` is the operator CLI; `oai` is the OAI end-user CLI. Fleet status, agent
self-management, tasks, logs, heuristics, and storage commands are documented in
[offloadmq-cli/README.md](offloadmq-cli/README.md). Authenticate with
`omqcli auth --key <management-token>`.

### Local development credentials

Use these supplied test values directly; **do not grep `.env` for them**.

| Purpose | Value |
| --- | --- |
| Client API key | `client_secret_key_123` |
| Agent API key | `ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e` |
| Management token | `this-is-for-testing-management-tokens` |

## MQ architecture and contracts

The MQ server uses Rust/Axum, Tokio, Sled, and OpenDAL. Start with
[src/main.rs](src/main.rs) (routes), [src/models.rs](src/models.rs) (models),
[src/schema.rs](src/schema.rs) (DTOs), and [src/middleware/](src/middleware/) (auth).

| API surface | Reference |
| --- | --- |
| Client tasks (`/api/*`); agent execution (`/private/agent/*`) | [Tasks API](docs/tasks-api.md) |
| Client buckets (`/api/storage/*`) | [Client storage API](docs/client-storage-api.md) |
| Management (`/management/*`) | [Management API](docs/management-api.md), [management storage](docs/management-storage-api.md) |
| LLM/vision integration, payloads, progress, errors | [LLM integration guide](docs/integration-guide-llm.md) |
| Custom capability payload schemas | [Custom capabilities](docs/custom-capabilities.md) |

- Client API management override: `X-MGMT-API-KEY: <mgmt_token>` bypasses
  client-key/capability checks.
- Task API JSON uses camelCase; Storage API uses snake_case.
- Clients submit **base capabilities**, e.g. `llm.qwen3:8b`. Agents may register
  `llm.qwen3:8b[vision;tools;8b]`. Matching strips attributes; use
  `base_capability()` / `capability_attrs()` in [src/utils.rs](src/utils.rs).
  Base and extended listings have separate endpoints; consult the API docs.
- Urgent tasks (`submit_blocking`) live in memory with a 60-second TTL and notify
  waiting clients through watch channels. Regular tasks (`submit`) persist in Sled.
  Agent communication primarily uses WebSocket push; HTTP polling is deprecated.
- Preserve urgent-first selection and regular-task tier priority. Within the
  eligible regular pool, select the oldest task (`createdAt`, task ID tie-break).
  Agents are online when last contact is less than 120 seconds old.
  See [src/mq/](src/mq/) and [persistent task storage](src/db/persistent_task_storage.rs).
- Buckets are scoped to a client API key; enforce ownership on every request.
  Default limits: 256 buckets/key, 1 GiB/bucket, 24-hour TTL. Upload metadata includes SHA-256.
- Bucket cleanup runs at startup and every 3 hours: reap spent `rm_after_task`
  buckets, then expired buckets; delete stored files before metadata.
  The spent-bucket sweep requires recorded tasks all terminal/missing and a
  10-minute minimum age. Buckets without recorded tasks remain subject to TTL.
  See [bucket_reaper.rs](src/storage/bucket_reaper.rs).

### ComfyUI workflows

Reference workflows in `agent_v2/workflows/` are **not installed automatically**.
Operators copy them into `$OFFLOAD_WORKFLOWS_DIR`, otherwise
`~/.offload-agent/workflows/`.

| Capability | Path relative to workflow root | Contract |
| --- | --- | --- |
| `imggen.<workflow>` | `<workflow>/<task-type>.json` | [Comfy API](docs/comfy-api.md) |
| `txt2music.<workflow>` | `txt2music/<workflow>/<task-type>.json` | [Comfy API](docs/comfy-api.md) |
| `img-utils.<utility>` | `img-utils/<utility>/<task-type>.json` | [Image utilities API](docs/img-utils-api.md) |

`txt2music/` and `img-utils/` are namespaces; other flat workflow directories map
to `imggen`. An `img-utils` capability is advertised only when its directory exists
(no config flag). These transforms take images and return one image without a
prompt; the utility name is the default task type when `payload.workflow` is omitted.

## OAI architecture

OAI (`oai/`) is a separate React 19/TypeScript/Vite/shadcn SPA and stateless
Rust/Axum backend. State lives in PostgreSQL (SeaORM) and OpenDAL FS or S3/Garage.
It submits/polls OffloadMQ tasks; MQ connection settings are admin-configurable.
Deployment: `oai.alexgr.space`, image `grekodocker/oai`.

- Backend entry points: `src/app.rs` (router), `src/state.rs` (`AppState`),
  `src/db/migrator.rs` + `src/db/migrator/` (migrations run on startup).
  Paths here are relative to `oai/backend/`.
- Reuse the offload-job framework for new submit/poll/persist features:
  `db/offload_jobs.rs`, `services/offload_job.rs`, `offload/task_status.rs`,
  `jobs/worker_runtime.rs`, `routes/job_common.rs`. Supply feature traits,
  `start_job`, and completed-result handling; see `oai-new-feature`.
  Chat WS and the image generation pipeline have bespoke lifecycles.
- Release job buckets on **every terminal transition**. Image generation uses
  `image_jobs::release_job_buckets` for both input and output buckets.
- Frontend routing: `oai/frontend/src/App.tsx`; auth: `contexts/AuthContext.tsx`
  (`oai_token` in localStorage). Authenticated API clients share
  [api/http.ts](oai/frontend/src/api/http.ts) (`apiRequest`).
- Image Cycles and Generator Improver share an engine with separate histories.
  Preserve historical model snapshots and saved-response JSON retry without new
  inference. Lifecycle details: [Image Cycles](docs/oai-image-cycles.md) and
  [Generator Improver](docs/oai-generator-improver.md).

## Configuration, deployment, and releases

MQ reads `.env`: `SERVER_ADDRESS` (default `0.0.0.0:3069`),
`DATABASE_ROOT_PATH`, `JWT_SECRET`, `AGENT_API_KEYS`, `CLIENT_API_KEYS`, `MGMT_TOKEN`.
Storage uses `STORAGE_BACKEND=local|webdav|s3` and `STORAGE_LOCAL_ROOT`;
limits use `STORAGE_MAX_BUCKETS_PER_KEY`, `STORAGE_BUCKET_SIZE_BYTES`,
`STORAGE_BUCKET_TTL_MINUTES`. See [src/storage/mod.rs](src/storage/mod.rs).

OAI configuration is described in [oai-backend](.agents/skills/oai-backend/SKILL.md)
and [oai-devops](.agents/skills/oai-devops/SKILL.md). `JWT_SECRET` is required;
`DATABASE_URL` configures Postgres. `ROOT_ADMIN_PASSWORD` defaults to `000000`
on first boot; set it for deployments. OAI storage uses `STORAGE_BACKEND=fs|s3`
(or unset to disable), unlike MQ's `local|webdav|s3`.

Root deployment commands are in [Taskfile.yml](Taskfile.yml):
`task docker:release`, `task docker:release:frontend`, `task docker:release:multi`;
`task secrets` generates `.secrets.yaml`, required by `task deploy`, `task template`,
and `task diff`. `task ship` builds/pushes both images and deploys;
`task rollback` restores the previous Helm revision.
OAI has its own Docker/Helm commands in [oai/Taskfile.yml](oai/Taskfile.yml);
run them from `oai/` and read `oai-devops` first.

Agent releases: [docs/releasing.md](docs/releasing.md) is the full procedure.
From root, `task release` computes the version, creates/pushes `release-<version>`,
and builds/uploads binaries for the current platform. Tag push triggers Linux
amd64 CI. `task release:agent` builds/uploads without tagging; `VERSION=` overrides
the computed version. PyInstaller builds are platform-specific.
Windows build/upload: `.\scripts\release-agent.ps1 [version]`.
Scripts need `DL_API_KEY` (normally inherited from `~/.zshrc` on macOS/Linux);
target overrides are `DL_BASE_URL` and `DL_BUCKET`.
Install latest builds with `task agent:update:mac` or `task agent:update:linux`.
