---
name: oai-backend
description: Senior Rust engineer context for the OAI backend. Use when working on oai/backend — routes, services, WebSocket chat, image pipeline, DB migrations, middleware, OffloadMQ integration, or background workers.
---

# OAI Backend — Engineering Context

OAI backend is a stateless Rust/Axum service that sits between the React SPA and OffloadMQ. It handles auth, chat history, image job orchestration, and file storage. State lives in PostgreSQL (users, chats, image jobs) and OpenDAL storage (image files).

---

## Running Locally

```bash
# From oai/ — starts Postgres + backend (port 3001) + Vite (port 5174)
task dev

# Backend only (Postgres already up)
cd oai/backend && cargo run

# Backend listens on :3001 in dev; Vite proxies /api/* → :3001
```

Backend reads config from `oai/backend/.env`. In dev: `DATABASE_URL`, `JWT_SECRET`, optionally `OFFLOAD_MQ_CLIENT_KEY` / `OFFLOAD_MQ_MGMT_TOKEN` to seed admin settings on first boot.

---

## Module Map

```
oai/backend/src/
  main.rs                         # startup: DB connect, migrations, spawn workers, serve
  app.rs                          # create_app() — Router assembly, CORS, middleware layers
  state.rs                        # AppState { db, auth, snowflake, storage, http }
  error.rs                        # AppError enum → HTTP status + JSON { "error": "..." }
  snowflake.rs                    # i64 ID generator (epoch-based, node=1)
  storage.rs                      # build_operator() — OpenDAL FS or S3

  middleware/
    mod.rs                        # jwt_auth_middleware, admin_auth_middleware, AuthenticatedUser extractor
    auth.rs                       # Auth struct — bcrypt hash/verify, JWT encode/decode (30-day TTL)

  routes/
    mod.rs                        # pub mod declarations
    health.rs                     # GET /api/health
    auth.rs                       # register, login, me, change_password
    admin.rs                      # admin settings, connection check, image admin, k8s self
    chats.rs                      # CRUD chats + messages, system-prompt / last-model patches
    system_prompts.rs             # library list, record_use, delete, star/unstar
    images.rs                     # upload input, start/list/get/poll/cancel job, get image, capabilities
    files.rs                      # read-only user file browser
    progress.rs                   # GET /api/progress/running — global drawer feed
    tasks.rs                      # POST /api/tasks/cancel/:cap/:id
    debug.rs                      # POST /api/debug/offload_poll — raw OffloadMQ poll for ToolDebug

  ws/
    mod.rs
    chat.rs                       # WebSocket upgrade + ping/idle loop (transport only)
    events.rs                     # ServerEvent + ClientCommand enums (serde tag = "type")

  services/
    mod.rs
    chat.rs                       # chat domain: capability list, message persist, poll loop, reconcile
    image_jobs.rs                 # image domain: start/poll/cancel/reconcile jobs, download outputs
    image_processing.rs           # process_image() — resize, re-encode, SHA-256, EXIF strip
    image_pipeline_params.rs      # ImagePipelineParams — build + parse stored JSON
    image_job_names.rs            # display_name / prompt_label helpers
    offload_factory.rs            # chat_client() + image_client() — build OffloadMQ clients from DB settings
    progress.rs                   # list_running_image_jobs() → RunningJobsResponse
    storage.rs                    # operator(), read(), write() wrappers over AppState.storage
    connection.rs                 # check_offloadmq_connection()
    debug_offload.rs              # raw poll for debug route
    k8s_self.rs                   # k8s pod/log fetching for admin
    image_processing.rs           # MAX_UPLOAD_BYTES, process_image()

  offload/
    mod.rs                        # OffloadClient (LLM chat + capabilities), types: TaskId, ChatMessage, etc.
    image_tasks.rs                # OffloadImageClient (bucket create/upload/download, submit imggen task)

  db/
    mod.rs                        # connect() — SeaORM, runs migrations on boot
    migrator.rs                   # SeaORM Migrator — all migrations inline
    users.rs                      # find_by_login, find_by_id, create, create_admin, update_used_storage
    chats.rs                      # chat + message CRUD, finalize_message, list_pending_assistant_messages
    app_settings.rs               # singleton row get/update (offloadmq_url, api tokens)
    image_generation.rs           # jobs, files, pipeline events, offload tasks — full CRUD
    image_worker_logs.rs          # worker log rows
    llm_capabilities.rs           # sync_online(), list_for_display()
    user_system_prompts.rs        # library CRUD + star
    entities/                     # SeaORM entity structs (auto-derived, one per table)

  jobs/
    mod.rs
    image_pipeline_worker.rs      # tokio::spawn loop — background poll + reconcile image jobs
    chat_worker.rs                # tokio::spawn loop — background reconcile pending assistant messages
    llm_capability_cleanup_worker.rs  # marks LLM capabilities offline after inactivity
```

---

## AppState

```rust
pub struct AppState {
    pub db: DatabaseConnection,   // SeaORM Postgres pool
    pub auth: Auth,               // JWT encode/decode + bcrypt
    pub snowflake: SnowflakeGenerator,  // state.next_id() → i64
    pub storage: Option<Operator>, // OpenDAL — None when STORAGE_BACKEND unset
    pub http: reqwest::Client,    // shared HTTP client for OffloadMQ calls
}
```

All handlers receive `State(state): State<Arc<AppState>>`. IDs are always `state.next_id()` — never `uuid`, never DB auto-increment.

---

## Router Layout (`app.rs`)

Three route groups with separate middleware layers:

| Group | Middleware | Prefix examples |
|-------|-----------|-----------------|
| `public` | none | `/api/health`, `/api/auth/register`, `/api/auth/login` |
| `authenticated` | `jwt_auth_middleware` | `/api/me`, `/api/ws/chat`, `/api/chats/*`, `/api/images/*`, `/api/progress/*`, `/api/tasks/*` |
| `admin` | `admin_auth_middleware` (checks `is_admin=true`) | `/api/admin/*` |

Static SPA assets are served via `tower_http::ServeDir`; unmatched paths fall back to `index.html`.

---

## Full Route Reference

### Public
| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/health` | `routes::health::health` |
| POST | `/api/auth/register` | `routes::auth::register` |
| POST | `/api/auth/login` | `routes::auth::login` |

### Authenticated
| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/me` | `routes::auth::me` |
| POST | `/api/auth/change_password` | `routes::auth::change_password` |
| GET | `/api/admin/am_i_admin` | `routes::admin::am_i_admin` |
| WS | `/api/ws/chat` | `ws::chat::ws_chat` |
| GET | `/api/chats` | `routes::chats::list_chats` |
| POST | `/api/chats` | `routes::chats::create_chat` |
| DELETE | `/api/chats/{id}` | `routes::chats::delete_chat` |
| PATCH | `/api/chats/{id}/system-prompt` | `routes::chats::update_system_prompt` |
| PATCH | `/api/chats/{id}/last-model` | `routes::chats::update_last_model` |
| GET | `/api/chats/{id}/messages` | `routes::chats::get_messages` |
| GET | `/api/system-prompts` | `routes::system_prompts::list_library` |
| POST | `/api/system-prompts/use` | `routes::system_prompts::record_use` |
| DELETE | `/api/system-prompts/{id}` | `routes::system_prompts::delete_prompt` |
| PATCH | `/api/system-prompts/{id}/star` | `routes::system_prompts::set_starred` |
| GET | `/api/files` | `routes::files::list_files` |
| POST | `/api/images/upload` | `routes::images::upload_input_image` (10 MiB limit) |
| POST | `/api/images/jobs` | `routes::images::start_job` |
| GET | `/api/images/jobs` | `routes::images::list_jobs` |
| GET | `/api/images/capabilities` | `routes::images::list_imggen_capabilities` |
| GET | `/api/images/jobs/{id}` | `routes::images::get_job` |
| POST | `/api/images/jobs/{id}/poll` | `routes::images::poll_job` |
| POST | `/api/images/jobs/{id}/cancel` | `routes::images::cancel_job` |
| GET | `/api/images/files/{id}` | `routes::images::get_image` — token in `?token=` query param (for `<img src>`) |
| GET | `/api/progress/running` | `routes::progress::running_jobs` |
| POST | `/api/tasks/cancel/{cap}/{id}` | `routes::tasks::cancel_offload_task` |
| POST | `/api/debug/offload_poll` | `routes::debug::offload_poll` |

### Admin only
| Method | Path |
|--------|------|
| GET | `/api/admin/settings` |
| POST | `/api/admin/settings` |
| POST | `/api/admin/check_connection` |
| GET | `/api/admin/images/jobs` |
| GET | `/api/admin/images/jobs/{id}` |
| POST | `/api/admin/images/jobs/{id}/reconcile` |
| GET | `/api/admin/images/files` |
| GET | `/api/admin/images/events` |
| GET | `/api/admin/images/offload_tasks` |
| GET | `/api/admin/images/worker_logs` |
| GET | `/api/admin/k8s/self/pod` |
| GET | `/api/admin/k8s/self/logs` |

---

## Auth & Middleware

JWT tokens are HS256, 30-day TTL. Token extraction priority (highest → lowest):

1. `Authorization: Bearer <token>` header
2. `Cookie: token=<value>` or `Cookie: jwt=<value>`
3. `?token=<value>` query param — required for `GET /api/images/files/{id}` (used in `<img src>`) and WebSocket upgrade

`AuthenticatedUser(user_id: i64)` is injected into request extensions by both middleware functions and extracted in handlers via `AuthenticatedUser(user_id): AuthenticatedUser`.

`admin_auth_middleware` additionally checks `users.is_admin = true`. Returns 403 Forbidden (not 401) for authenticated non-admins.

---

## Error Handling

All handlers return `Result<impl IntoResponse, AppError>`. `AppError` maps to HTTP status + `{ "error": "message" }` JSON:

| Variant | Status |
|---------|--------|
| `Unauthorized` | 401 |
| `Forbidden` | 403 |
| `NotFound` | 404 |
| `BadRequest(msg)` | 400 |
| `Database(_)` | 500 (logs the error) |
| `Internal(msg)` | 500 (logs the message) |
| `ExternalService(msg)` | 502 (logs as warn) |
| `Jwt(_)` | 401 |
| `Bcrypt(_)` | 500 |

Use `?` freely — `sea_orm::DbErr` auto-converts via `#[from]`. Use `AppError::BadRequest` for invalid user input, `AppError::Internal` for impossible states, `AppError::ExternalService` for OffloadMQ failures.

---

## WebSocket Chat Protocol

Endpoint: `GET /api/ws/chat` (upgraded via `ws_chat` handler).

`ws/chat.rs` owns the transport (ping every 30s, idle timeout 120s). Domain logic lives in `services/chat.rs`.

### Client → Server (`ClientCommand`, `tag = "type"`)

```json
{ "type": "ping" }
{ "type": "list_capabilities", "req_id": "..." }
{ "type": "chat", "req_id": "...", "capability": "llm.qwen3:8b", "chat_id": "123", "content": "..." }
```

### Server → Client (`ServerEvent`, `tag = "type"`)

```json
{ "type": "hello", "user_id": 123 }
{ "type": "pong" }
{ "type": "capabilities", "req_id": "...", "capabilities": [...] }
{ "type": "task:queued",   "req_id": "...", "cap": "llm.qwen3:8b", "id": "abc" }
{ "type": "task:progress", "req_id": "...", "cap": "...", "id": "...", "status": "running", "stage": "...", "log": "..." }
{ "type": "task:result",   "req_id": "...", "cap": "...", "id": "...", "text": "...", "log": "..." }
{ "type": "task:failed",   "req_id": "...", "cap": "...", "id": "...", "error": "...", "log": "..." }
{ "type": "error", "req_id": "...", "message": "..." }
```

### Chat flow

1. Client sends `chat` command
2. `services::chat::run_chat` persists user message, submits to OffloadMQ (`POST /api/task/submit`)
3. Assistant reply row created immediately as `status="pending"` with `offload_cap` / `offload_task_id` set
4. Server sends `task:queued`
5. `poll_loop` spawned (tokio task) — polls every 1s up to 300 iterations (10 min)
6. Sends `task:progress` on each non-terminal status
7. On `completed`: finalizes DB row, sends `task:result`
8. On `failed`/`canceled`/timeout: finalizes DB row, sends `task:failed`

**Background reconciliation**: `jobs::chat_worker` runs independently — reconciles any `status="pending"` assistant messages even if the WS drops or the pod restarts. Deadline: 15 min from message creation.

---

## OffloadMQ Integration

All OffloadMQ HTTP calls go through `src/offload/`. Admin settings (DB singleton row `app_settings`) provide the URL and API key at runtime — never hardcoded.

### `OffloadClient` (chat + generic)

Built by `services::offload_factory::chat_client()`. Key methods:

- `list_llm_capabilities()` — calls `/api/capabilities/list/online_ext`, filters `llm.` prefix, syncs to `llm_capabilities` table
- `list_capabilities_with_prefix(prefix)` — generic prefix filter
- `submit_chat(capability, messages)` → `TaskId { cap, id }` — calls `POST /api/task/submit` with `urgent: false`
- `poll_task(task_id)` → `PollResponse { status, stage, output, log }`
- `poll_task_raw(task_id)` → `serde_json::Value` (for debug route)
- `cancel_task(task_id)` → `CancelTaskResponse`

### `OffloadImageClient` (image pipeline)

Built by `services::offload_factory::image_client()`. Requires non-empty API key (returns `BadRequest` otherwise).

- `create_bucket(single_use)` — creates OffloadMQ storage bucket
- `upload_bucket_file(bucket_uid, bytes, filename, content_type)`
- `download_bucket_file(bucket_uid, file_uid)` → `(Vec<u8>, content_type)`
- `submit_img_task(capability, payload, input_bucket_uid, output_bucket_uid, data_prep)` → `(OffloadTaskId, submit_payload_value)`
- `poll_task(task_id)` → `OffloadPollResponse`
- `cancel_task(task_id)` → `CancelTaskResponse`

Capability strings: LLM uses `llm.*`, image gen uses `imggen.*`. Capabilities with bracket attrs like `imggen.sdxl[fp16;gpu]` are parsed — `base` = `imggen.sdxl`, `tags` = `["fp16", "gpu"]`.

---

## Database

SeaORM with PostgreSQL 17. Migrations run automatically on startup via `db::connect()`. All IDs are snowflake `i64` — never serial/autoincrement.

### Tables

| Table | Key columns |
|-------|-------------|
| `users` | `id` (i64 PK), `login` (unique), `password_hash`, `is_admin`, `used_storage_bytes` |
| `app_settings` | single row (id=1): `offloadmq_url`, `client_api_token`, `management_api_token` |
| `chats` | `id`, `user_id`, `title`, `system_prompt`, `last_model`, `created_at`, `updated_at` |
| `chat_messages` | `id`, `chat_id`, `role`, `content`, `status` (complete/pending/failed), `model`, `offload_cap`, `offload_task_id` |
| `user_system_prompts` | `id`, `user_id`, `content`, `starred`, `last_used_at` |
| `llm_capabilities` | `base` (PK text), `tags_json`, `raw`, `last_available_at` |
| `image_generation_jobs` | `id`, `user_id`, `status`, `prompt`, `capability`, `workflow`, `width`, `height`, `seed`, `input_image_id`, `error`, `display_name`, `pipeline_params_json` |
| `image_files` | `id`, `user_id`, `job_id`, `direction` (input/output), `storage_path`, `filename`, `content_type`, `stored_bytes`, dimensions, `sha256`, offload bucket/file uids |
| `image_pipeline_events` | `id`, `job_id`, `step`, `state`, `details`, `created_at` |
| `image_offload_tasks` | `id`, `job_id`, `offload_cap`, `offload_task_id`, `submit_payload`, last poll fields |
| `image_worker_logs` | `id`, `run_id`, `level`, `message`, `data_json`, `created_at` |

### Adding a Migration

Add a new `mod` inside `migrator.rs` and push a `Box::new(...)` to the `migrations()` vec. Naming convention: `m{YYYYMMDD}_{NNNNNN}_{description}`. Migrations run once on boot — always provide a `down()`.

---

## Background Workers

Three workers spawned in `main.rs`:

| Worker | File | Interval | Job |
|--------|------|----------|-----|
| `image_pipeline_worker` | `jobs/image_pipeline_worker.rs` | ~10s | Polls submitted image jobs, downloads outputs, reconciles completed jobs with missing files |
| `chat_worker` | `jobs/chat_worker.rs` | ~5s | Reconciles `status="pending"` assistant messages via OffloadMQ poll |
| `llm_capability_cleanup_worker` | `jobs/llm_capability_cleanup_worker.rs` | ~60s | Marks LLM capabilities `online=false` if not seen recently |

Workers call `services::image_jobs::run_background_reconcile_pass` / `services::chat::run_background_reconcile_pass`. They tolerate OffloadMQ being down — log warnings and continue.

---

## Storage

`AppState.storage: Option<Operator>`. `None` when `STORAGE_BACKEND` env var is unset (disables upload/download routes).

| `STORAGE_BACKEND` | Vars needed |
|-------------------|-------------|
| `fs` | `STORAGE_FS_ROOT` |
| `s3` | `STORAGE_S3_ENDPOINT`, `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` |

`services::storage::operator(state)` returns `Result<&Operator, AppError::Internal>` — use this at the top of any handler that needs file I/O. `services::storage::read(op, path)` and `services::storage::write(op, path, bytes)` are the only wrappers needed.

Image storage path convention: `users/{user_id}/images/{input|output}/{job_id}/{image_id}.jpg`

---

## Admin Settings

`app_settings` is a DB singleton (id=1). Seeded on first boot from `OFFLOAD_MQ_CLIENT_KEY` / `OFFLOAD_MQ_MGMT_TOKEN` env vars if the columns are null. After that, changes go through `POST /api/admin/settings`. Always call `app_settings::get(&state.db).await?` fresh — no caching.

---

## Common Patterns

### Adding a Route

1. Add handler to the appropriate `routes/*.rs` file
2. Register in `app.rs` under the correct group (`public`, `authenticated`, or `admin`)
3. If domain logic is > trivial, put it in a `services/*.rs` function — handlers should be thin (parse → call service → map DTO)

```rust
// Thin handler pattern
pub async fn my_handler(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<MyRequest>,
) -> Result<Json<MyResponse>, AppError> {
    let result = services::my_module::do_work(&state, user_id, req).await?;
    Ok(Json(result.into()))
}
```

### Adding a DB Function

- Put it in the appropriate `db/*.rs` module (not in `services/`)
- Use SeaORM `ActiveModel` for inserts, raw queries only when necessary
- Return `Result<T, AppError>` — `sea_orm::DbErr` auto-converts via `?`

### Adding a Migration

```rust
// In migrator.rs — add to migrations() vec and add the mod below
Box::new(m20260522_000014_my_change::Migration),

mod m20260522_000014_my_change {
    use sea_orm_migration::prelude::*;
    pub struct Migration;
    impl MigrationName for Migration {
        fn name(&self) -> &str { "m20260522_000014_my_change" }
    }
    #[async_trait::async_trait]
    impl MigrationTrait for Migration {
        async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> { ... }
        async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> { ... }
    }
    // Iden enums for table/column names
}
```

### Root Admin

On first boot, if no user with login `root` exists, one is created. Password from `ROOT_ADMIN_PASSWORD` env var (default `000000`). The `root` user has `is_admin=true`.

---

## Complex Tasks — Always Use Todos

For multi-file work, use `TodoWrite` before starting and mark steps complete as you go.
