---
name: oai-backend
description: >-
  Senior Rust engineer context for the OAI backend. Use when working on oai/backend/**
  — routes, services, DB migrations, middleware, OffloadMQ integration, or background
  workers. Stack with oai-chat or oai-img when editing feature-specific backend files.
---

# OAI Backend — Engineering Context

OAI backend is a stateless Rust/Axum service that sits between the React SPA and OffloadMQ. It handles auth, chat history, and the orchestration of every "AI job" feature (image generation, image tools, describe, nude detect, tts, music, llm compare/debate, movie studio) plus file storage. State lives in PostgreSQL and OpenDAL storage (image/audio/video blobs).

---

## Running Locally

```bash
# From oai/ — starts Postgres + backend (port 3001) + Vite (port 5174)
task dev

# Backend only (Postgres already up)
cd oai/backend && cargo run

# Backend listens on :3001 in dev; Vite proxies /api/* → :3001
```

Backend reads config from `oai/backend/.env`. In dev: `DATABASE_URL`, `JWT_SECRET`, `SERVER_ADDRESS`, `STORAGE_BACKEND` / `STORAGE_FS_ROOT`, optionally `OFFLOAD_MQ_CLIENT_KEY` / `OFFLOAD_MQ_MGMT_TOKEN` to seed admin settings on first boot.

---

## Module Map

```
oai/backend/src/
  main.rs                         # startup: DB connect, migrations, root admin, seed settings, spawn 12 workers, serve
  app.rs                          # create_app() — Router assembly, CORS, middleware layers, SPA fallback
  state.rs                        # AppState { db, auth, snowflake, storage, http }
  error.rs                        # AppError enum → HTTP status + JSON { "error": "..." }
  snowflake.rs                    # i64 ID generator (epoch-based, node=1)
  storage.rs                      # build_operator() — OpenDAL fs/local, s3, or none
  version.rs                      # build_version() — OAI_BUILD_VERSION baked at image build, "dev" locally

  middleware/
    mod.rs                        # jwt_auth_middleware, admin_auth_middleware, AuthenticatedUser, extract_jwt_token
    auth.rs                       # Auth struct — bcrypt hash/verify, JWT encode/decode (30-day TTL)

  routes/
    health.rs                     # GET /api/health, GET /api/version
    auth.rs                       # register, login, me, change_password
    admin.rs                      # admin settings, connection check, image admin, k8s self
    chats.rs                      # CRUD chats + messages, system-prompt / last-model patches
    chat_attachments.rs           # upload/reference documents, image attachments, list, download
    prompts.rs                    # generic prompt library — per-user buckets, recent/starred
    promptgen.rs                  # prompt generator over REST (WS variant lives in ws/promptgen.rs)
    images.rs                     # upload, start/list/get/poll/cancel/retry/delete job, image bytes/thumbnail/star, capabilities
    job_common.rs                 # parse_id + shared StartJobResponse/CancelJobResponse DTOs
    describe.rs                   # image-analysis (vision) jobs
    nude_detect.rs                # NudeNet detection jobs
    tts.rs                        # text-to-speech jobs (+ /audio)
    music_generation.rs           # txt2music jobs (+ /audio/{track})
    img_utils.rs                  # img-utils.* transforms + built-in image_resize
    llm_compare.rs                # multi-model side-by-side comparison jobs
    llm_debate.rs                 # two-model debate jobs (+ referee)
    movie.rs                      # movie studio jobs (approve/stop/resume/retry/cancel)
    files.rs                      # user file browser, per-file properties, bulk cleanup
    names.rs                      # GET /api/names/random — display-name suggestions
    runners.rs                    # GET /api/runners/online — online agents via management API
    progress.rs                   # GET /api/progress/running — global drawer feed
    tasks.rs                      # POST /api/tasks/cancel/{cap}/{id}
    debug.rs                      # POST /api/debug/offload_poll — raw OffloadMQ poll for ToolDebug

  ws/
    chat.rs                       # /api/ws/chat — upgrade + ping/idle loop (transport only)
    promptgen.rs                  # /api/ws/promptgen — prompt + video-prompt generation
    debate.rs                     # /api/ws/debate — watch a debate job
    movie.rs                      # /api/ws/movie — watch a movie job + capabilities
    events.rs                     # ServerEvent + per-socket ClientCommand enums (serde tag = "type")

  services/
    chat.rs                       # chat domain: capabilities, persist, submit, poll loop, reconcile
    chat_attachments.rs           # document/image attachments + stage_into_bucket for llm tasks
    offload_job.rs                # GENERIC poll/cancel/reconcile driver + JobReconciler trait
    image_analysis.rs             # describe (vision) — JobReconciler impl + start/retry
    nude_detect.rs                # NudeNet — JobReconciler impl + start/retry + availability
    tts.rs                        # text-to-speech — JobReconciler impl + start/retry
    music_generation.rs           # txt2music — JobReconciler impl + start/retry (image client poller)
    img_utils.rs                  # img-utils.* + image_resize — JobReconciler impl + start/retry
    image_resize.rs               # payload rules for the built-in image_resize capability
    external_resize.rs            # offload the input downscale to a cheap agent task (pre-step chain)
    llm_compare.rs                # bespoke multi-slot LLM fan-out + reconcile
    llm_debate.rs                 # bespoke turn-based debate state machine + reconcile
    movie.rs                      # bespoke movie state machine (outline → scenes → concat) + reconcile
    movie_ffmpeg.rs               # frame extraction + clip concatenation
    image_jobs.rs                 # image domain: start/poll/cancel/retry/delete, downloads, file browsing (bespoke)
    image_processing.rs           # process_image() — resize, re-encode, SHA-256, EXIF; size/edge limits
    image_paths.rs                # canonical OpenDAL paths for image/thumbnail/video/movie blobs
    image_pipeline_params.rs      # ImagePipelineParams — build + parse stored JSON
    image_job_names.rs            # display_name / prompt_label / generate_random_names
    llm_text_capabilities.rs      # shared text-LLM capability listing (compare, debate, movie)
    offload_factory.rs            # chat_client() / image_client() from DB settings
    progress.rs                   # list_running_image_jobs() → RunningJobsResponse
    promptgen.rs                  # prompt generator: capabilities, generate, poll, WS variants
    runners.rs                    # online agent summaries via the management API
    storage.rs                    # operator(), read(), write(), exists(), delete()
    connection.rs                 # check_offloadmq_connection()
    debug_offload.rs              # raw poll for debug route
    k8s_self.rs                   # k8s pod/log fetching for admin

  offload/
    mod.rs                        # OffloadClient (chat, vision, nudenet, tts, capabilities, buckets)
    image_tasks.rs                # OffloadImageClient (buckets + imggen/img-utils/video task submit)
    task_status.rs                # status helpers, WORKER_PICKUP_STATUSES, NormalizedPoll, OffloadPoller

  db/
    mod.rs                        # connect() — SeaORM, runs migrations on boot
    migrator.rs                   # SeaORM Migrator — all migrations inline (32 as of m20260806_000032)
    users.rs                      # find_by_login/id, create, create_admin, update_password_hash, update_used_storage
    chats.rs                      # chat + message CRUD, add_pending_assistant_message, finalize_message
    chat_attachments.rs           # attachment rows
    app_settings.rs               # singleton row get/update (offloadmq_url, api tokens)
    offload_jobs.rs               # GENERIC job ops + OffloadJobEntity/OffloadJobModel traits + stale-row reaping
    image_analysis.rs / nude_detect.rs / tts.rs / music_generation.rs / img_utils.rs
                                  # per-feature create_job + result setters + framework trait impls
    llm_compare.rs / llm_debate.rs / movie.rs   # bespoke job tables
    image_generation.rs           # jobs, files, pipeline events, offload tasks — full CRUD (bespoke)
    image_worker_logs.rs          # worker log rows
    llm_capabilities.rs           # sync_online(), list_for_display(), delete_stale()
    imggen_capabilities.rs        # same shape for imggen.* capabilities
    prompts.rs                    # prompt library (prompt_entries: bucket + kind recent/starred)
    generation_parameters.rs      # parsed generation params extracted from uploaded images
    entities/                     # SeaORM entity structs (one per table)

  jobs/
    worker_runtime.rs             # spawn(state, WorkerConfig, pass_fn) — generic tick loop
    image_pipeline_worker.rs      # bespoke loop (also writes run logs) — poll + reconcile image jobs
    chat_worker.rs                # reconcile pending assistant messages
    image_analysis_worker.rs / nude_detect_worker.rs / tts_worker.rs / music_generation_worker.rs
    img_utils_worker.rs / llm_compare_worker.rs / llm_debate_worker.rs / movie_worker.rs
                                  # ~6-line configs over worker_runtime
    llm_capability_cleanup_worker.rs  # deletes stale LLM capability rows
    stale_job_reaper.rs           # hourly backstop: fails jobs stuck non-terminal past the age threshold
```

---

## Offload-Job Framework

Most features are the same "submit an OffloadMQ task → poll → persist result" shape. Five of them run on the shared framework — **describe** (image analysis), **nude_detect**, **tts**, **music_generation**, **img_utils** — so a new feature writes only its unique logic. Build a new one with the **oai-new-feature** skill; the pieces:

| Concern | Where | What you implement per feature |
|---------|-------|-------------------------------|
| Generic DB ops (`get_job`, `list_jobs`, `delete_job`, `update_status`, `set_offload_task`, `list_jobs_for_background_worker`, `fail_stale_jobs`) | `db/offload_jobs.rs` | `impl OffloadJobEntity for <Entity>` (column accessors, incl. optional `col_bucket`) + `impl OffloadJobModel for <Model>` (`id`/`status`/`offload_cap`/`offload_task_id`/optional `bucket_uid`). Keep `create_job` + result setters in `db/<feature>.rs`. |
| Status helpers + normalized poll/cancel/bucket-delete over both clients | `offload/task_status.rs` | nothing — reuse `is_terminal`, `is_executing`, `WORKER_PICKUP_STATUSES`, `extract_llm_text`, `extract_error_text(out, fallback)`, `offload_task_missing_message`, `OffloadPoller`. |
| poll / cancel / reconcile state machine | `services/offload_job.rs` | `impl JobReconciler` on a ZST: `type Entity`, `label`, `failure_fallback`, `poller` (chat vs image client), `on_completed` (persist result), optional `on_poll` (per-poll extras like `started_at` / `typical_runtime_seconds`). Then thin wrappers `poll_job`/`cancel_job`/`run_background_reconcile_pass` delegate to the driver. |
| Background worker | `jobs/worker_runtime.rs` | a ~6-line `spawn` with a `WorkerConfig` + the reconcile pass fn. |
| Route DTOs / id parsing | `routes/job_common.rs` | reuse `parse_id`, `StartJobResponse::submitted(id)`, `CancelJobResponse::from(outcome)`. |

Three behaviours the driver owns, worth knowing before you re-implement them:

- **Bucket lifetime.** Every terminal transition calls `release_bucket` on the job's `bucket_uid()`, best-effort. Input buckets carry `rm_after_task`, but that never fires for a task canceled while queued, and output buckets carry no flag at all — so without this they would survive to the server's 24 h TTL. On `completed` the bucket is released *after* `on_completed` succeeds, so a retry still has its inputs. Image generation does the same in `image_jobs::release_job_buckets`.
- **Permanent vs transient failure.** An error out of `on_completed` is classified: `BadRequest` (payload too large / undecodable — every retry fails identically) marks the job failed; everything else leaves it in flight for the next tick.
- **Stale backstop.** `jobs/stale_job_reaper.rs` fails any non-terminal row older than `STALE_JOB_REAPER_MAX_AGE_HOURS` (default 24 h, hourly tick) across both framework tables (`fail_stale_jobs`) and bespoke ones (`fail_stale_rows`) — catching rows that never got an OffloadMQ task id and are therefore invisible to every other worker.

`OffloadPoller` normalizes the two concrete clients (`OffloadClient`, `OffloadImageClient`) — both hit the same upstream endpoints; a feature picks one in `JobReconciler::poller`. The generic DB writes use `update_many().col_expr(...)` so they work over any entity implementing the trait.

**Bespoke, deliberately off the framework:** chat (WebSocket streaming), image generation (multi-file pipeline + its own event log), llm_compare / llm_debate (multi-task fan-out and turn state machines), movie (multi-phase, ffmpeg). They still use `worker_runtime` for their tick loop and `task_status` helpers.

---

## AppState

```rust
pub struct AppState {
    pub db: DatabaseConnection,   // SeaORM Postgres pool
    pub auth: Auth,               // JWT encode/decode + bcrypt
    pub snowflake: SnowflakeGenerator,  // state.next_id() → i64
    pub storage: Option<Operator>, // OpenDAL — None when STORAGE_BACKEND=none
    pub http: reqwest::Client,    // shared HTTP client for OffloadMQ calls
}
```

All handlers receive `State(state): State<Arc<AppState>>`. IDs are always `state.next_id()` — never `uuid`, never DB auto-increment.

---

## Router Layout (`app.rs`)

Three route groups with separate middleware layers:

| Group | Middleware | Prefix examples |
|-------|-----------|-----------------|
| `public` | none | `/api/health`, `/api/version`, `/api/auth/register`, `/api/auth/login` |
| `authenticated` | `jwt_auth_middleware` | `/api/me`, `/api/ws/*`, `/api/chats/*`, `/api/images/*`, every `/api/<feature>/jobs*`, `/api/progress/*`, `/api/tasks/*` |
| `admin` | `admin_auth_middleware` (checks `is_admin=true`) | `/api/admin/*` (except `/api/admin/am_i_admin`, which is authenticated) |

`/assets` is served by a `ServeDir` with **no** fallback (a missing hashed chunk must 404, not return HTML); all other unmatched paths fall back to `index.html`. CORS allows localhost:5173/5174 and `https://oai.alexgr.space` with credentials.

Two routes carry a `DefaultBodyLimit` override: `/api/images/upload` (`image_processing::MAX_UPLOAD_BYTES` = 32 MiB) and `/api/chat/attachments/upload` (`chat_attachments::MAX_DOCUMENT_BYTES` = 100 MiB).

---

## Full Route Reference

### Public
| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/health` | `health::health` — `{ status, version }` |
| GET | `/api/version` | `health::version` — SPA polls it to detect new deploys |
| POST | `/api/auth/register` | `auth::register` |
| POST | `/api/auth/login` | `auth::login` |

### Authenticated — account & chat
| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/me` | `auth::me` |
| POST | `/api/auth/change_password` | `auth::change_password` |
| GET | `/api/admin/am_i_admin` | `admin::am_i_admin` |
| WS | `/api/ws/chat` | `ws::chat::ws_chat` |
| WS | `/api/ws/promptgen` | `ws::promptgen::ws_promptgen` |
| WS | `/api/ws/debate` | `ws::debate::ws_debate` |
| WS | `/api/ws/movie` | `ws::movie::ws_movie` |
| GET/POST | `/api/chats` | `chats::list_chats` / `create_chat` |
| DELETE | `/api/chats/{id}` | `chats::delete_chat` |
| PATCH | `/api/chats/{id}/system-prompt` | `chats::update_system_prompt` |
| PATCH | `/api/chats/{id}/last-model` | `chats::update_last_model` |
| GET | `/api/chats/{id}/messages` | `chats::get_messages` |
| POST | `/api/chat/attachments/upload` | `chat_attachments::upload_document` (100 MiB limit) |
| POST | `/api/chat/attachments/image` | `chat_attachments::create_image_attachment` |
| POST | `/api/chat/attachments/reference` | `chat_attachments::reference_document` |
| GET | `/api/chat/attachments/documents` | `chat_attachments::list_documents` |
| GET | `/api/chat/attachments/{id}/download` | `chat_attachments::download_document` |

### Authenticated — prompts, files, misc
| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/promptgen/capabilities` | `promptgen::list_capabilities` |
| POST | `/api/promptgen/generate` | `promptgen::generate` |
| POST | `/api/promptgen/poll` | `promptgen::poll` |
| GET | `/api/prompts/{bucket}` | `prompts::list_library` |
| POST | `/api/prompts/{bucket}/star` | `prompts::star` |
| PATCH/DELETE | `/api/prompt-entries/{id}` | `prompts::update_entry` / `delete_entry` |
| GET | `/api/files` | `files::list_files` |
| GET | `/api/files/properties` | `files::get_file_properties` |
| POST | `/api/files/cleanup` | `files::cleanup_files` |
| GET | `/api/names/random` | `names::random_names` |
| GET | `/api/runners/online` | `runners::list_online` |
| GET | `/api/progress/running` | `progress::running_jobs` |
| POST | `/api/tasks/cancel/{cap}/{id}` | `tasks::cancel_offload_task` |
| POST | `/api/debug/offload_poll` | `debug::offload_poll` |

### Authenticated — image generation
| Method | Path | Handler |
|--------|------|---------|
| POST | `/api/images/upload` | `images::upload_input_image` (32 MiB limit) |
| POST/GET | `/api/images/jobs` | `images::start_job` / `list_jobs` |
| GET | `/api/images/capabilities` | `images::list_imggen_capabilities` |
| GET | `/api/images/external-resize` | `images::external_resize_info` |
| GET/DELETE | `/api/images/jobs/{id}` | `images::get_job` / `delete_job` |
| POST | `/api/images/jobs/{id}/poll` \| `/cancel` \| `/retry` | `images::poll_job` / `cancel_job` / `retry_job` |
| GET/DELETE | `/api/images/files/{id}` | `images::get_image` / `delete_image` — token in `?token=` for `<img src>` |
| GET | `/api/images/files/{id}/thumbnail` | `images::get_image_thumbnail` |
| GET/PATCH | `/api/images/files/{id}/starred` | `images::get_image_starred` / `set_image_starred` |

### Authenticated — offload-job features (uniform shape)

Every feature below exposes the same routes; `{f}` is the prefix in the table:

```
POST   /api/{f}/jobs            start
GET    /api/{f}/jobs            list
GET    /api/{f}/jobs/{id}       detail
DELETE /api/{f}/jobs/{id}       delete
POST   /api/{f}/jobs/{id}/poll  foreground poll
POST   /api/{f}/jobs/{id}/cancel
POST   /api/{f}/jobs/{id}/retry
```

| `{f}` | Module | Discovery route | Extra routes |
|-------|--------|-----------------|--------------|
| `describe` | `routes::describe` | `GET /api/describe/capabilities` | — |
| `nude-detect` | `routes::nude_detect` | `GET /api/nude-detect/availability` | — |
| `tts` | `routes::tts` | `GET /api/tts/capabilities` | `GET /api/tts/jobs/{id}/audio` |
| `music-gen` | `routes::music_generation` | `GET /api/music-gen/capabilities` | `GET /api/music-gen/jobs/{id}/audio/{track}` |
| `img-utils` | `routes::img_utils` | `GET /api/img-utils/capabilities` | — |
| `llm-compare` | `routes::llm_compare` | `GET /api/llm-compare/capabilities` | — |
| `llm-debate` | `routes::llm_debate` | `GET /api/llm-debate/capabilities` | — |
| `movie` | `routes::movie` | `GET /api/movie/capabilities` | `POST .../approve`, `.../stop`, `.../resume` — the multi-phase state machine |

### Admin only
| Method | Path |
|--------|------|
| GET/POST | `/api/admin/settings` |
| POST | `/api/admin/check_connection` |
| GET | `/api/admin/images/jobs`, `/api/admin/images/jobs/{id}` |
| POST | `/api/admin/images/jobs/{id}/reconcile` |
| GET | `/api/admin/images/files`, `/events`, `/offload_tasks`, `/worker_logs` |
| GET | `/api/admin/k8s/self/pod`, `/api/admin/k8s/self/logs` |

---

## Auth & Middleware

JWT tokens are HS256, 30-day TTL. Token extraction priority (highest → lowest), in `middleware::extract_jwt_token`:

1. `Authorization: Bearer <token>` header
2. `Cookie: token=<value>` or `Cookie: jwt=<value>`
3. `?token=<value>` query param (URL-decoded) — required for `GET /api/images/files/{id}` (used in `<img src>`) and WebSocket upgrades

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

Use `?` freely — `sea_orm::DbErr` auto-converts via `#[from]`. Use `AppError::BadRequest` for invalid user input, `AppError::Internal` for impossible states, `AppError::ExternalService` for OffloadMQ failures. Note the framework's failure classifier treats `BadRequest` out of `on_completed` as *permanent* — don't use it for transient conditions there.

---

## WebSocket Protocol

Four sockets, all under `jwt_auth_middleware` (token via `?token=`): `/api/ws/chat`, `/api/ws/promptgen`, `/api/ws/debate`, `/api/ws/movie`. Each `ws/*.rs` owns transport only (ping every 30 s, idle timeout 120 s); domain logic lives in the matching `services/*.rs`. All enums are in `ws/events.rs` with `tag = "type"`, `rename_all = "snake_case"`.

### Chat — Client → Server (`ClientCommand`)

```json
{ "type": "ping" }
{ "type": "list_capabilities", "req_id": "..." }
{ "type": "chat", "req_id": "...", "capability": "llm.qwen3:8b", "chat_id": "123",
  "content": "...", "attachment_ids": ["..."], "model_online": true,
  "timeout_secs": null, "max_wait_secs": null, "runtime_secs": null }
```

`model_online` picks the queue-wait default: 5 min when the model is up, 24 h when it is offline (wait for it to come back). `runtime_secs` defaults to 15 min; the poll deadline is `timeout_secs` if given, else `max_wait + runtime`.

### Chat — Server → Client (`ServerEvent`)

```json
{ "type": "hello", "user_id": 123 }
{ "type": "pong" }
{ "type": "capabilities", "req_id": "...", "capabilities": [...] }
{ "type": "task:queued",   "req_id": "...", "cap": "...", "id": "..." }
{ "type": "task:progress", "req_id": "...", "cap": "...", "id": "...", "status": "running", "stage": "...", "log": "..." }
{ "type": "task:result",   "req_id": "...", "cap": "...", "id": "...", "text": "...", "log": "..." }
{ "type": "task:failed",   "req_id": "...", "cap": "...", "id": "...", "error": "...", "log": "..." }
{ "type": "error", "req_id": "...", "message": "..." }
```

Debate and movie sockets reuse `ServerEvent` with their own variants — `debate:update` / `movie:update` (`{ req_id, job, terminal }`, carrying the full `DebateJobView` / `MovieJobView`) and `movie_capabilities` (`{ req_id, llm, video }`). Their commands are `DebateClientCommand` / `MovieClientCommand`: `list_capabilities`, `watch_job { req_id, job_id }`, `ping`. `PromptGenClientCommand` adds `generate_prompt { mode, capability, query, prompt }` and `generate_video_prompt { capability, image_id }`.

### Chat flow

1. Client sends `chat`; attachments (if any) are staged into a one-shot OffloadMQ bucket
2. `services::chat::run_chat` persists the user message and submits to OffloadMQ (`POST /api/task/submit`)
3. Assistant reply row created immediately as `status="pending"` with `offload_cap` / `offload_task_id` set
4. Server sends `task:queued`
5. `poll_loop` spawned (tokio task) — polls every 1 s until the resolved deadline
6. Sends `task:progress` on each non-terminal status
7. On `completed`: finalizes DB row, sends `task:result`
8. On `failed`/`canceled`/timeout: finalizes DB row, sends `task:failed`

**Background reconciliation**: `jobs::chat_worker` runs independently — reconciles any `status="pending"` assistant message even if the WS drops or the pod restarts. Deadline: `RECONCILE_DEADLINE_SECS` = 15 min from message creation.

---

## OffloadMQ Integration

All OffloadMQ HTTP calls go through `src/offload/`. Admin settings (DB singleton row `app_settings`) provide the URL and API key at runtime — never hardcoded. **Always submit with the base capability** (brackets stripped); raw extended capabilities black-hole the task.

### `OffloadClient` (chat + generic)

Built by `services::offload_factory::chat_client()`.

- `list_llm_capabilities()` — `/api/capabilities/list/online_ext`, filters `llm.` prefix
- `list_capabilities_with_prefix(prefix)` / `list_capabilities_raw()`
- `submit_chat(capability, messages, timeout_secs, max_wait_secs, runtime_secs, file_bucket)` → `TaskId { cap, id }`
- `submit_vision_task(capability, messages, bucket_uid, data_preparation)` → `TaskId`
- `submit_nudenet_task(threshold, bucket_uid)` → `TaskId`
- `submit_tts_task(capability, model, voice, text)` → `TaskId`
- `poll_task(task_id)` → `PollResponse { status, stage, output, log, typical_runtime_seconds }`
- `poll_task_raw(task_id)` → `serde_json::Value` (debug route)
- `cancel_task(task_id)` → `CancelTaskResponse`; `delete_bucket(bucket_uid)`

### `OffloadImageClient` (image pipeline, img-utils, music, video)

Built by `services::offload_factory::image_client()` (or `image_client_from_settings`). Requires a non-empty API key (returns `BadRequest` otherwise).

- `create_bucket(rm_after_task)` — `rm_after_task=true` for inputs, `false` for outputs you must download
- `upload_bucket_file(bucket_uid, bytes, filename, content_type)`
- `download_bucket_file(bucket_uid, file_uid)` → `(Vec<u8>, content_type)`
- `submit_img_task(capability, payload, input_bucket_uid, output_bucket_uid, data_preparation)` → `(OffloadTaskId, submit_payload_value)`
- `poll_task(task_id)` → `OffloadPollResponse`; `cancel_task(task_id)`; `delete_bucket(bucket_uid)`

Capability prefixes: `llm.*` (chat/vision), `imggen.*` (image + video), `img-utils.*` (transforms), `txt2music.*`, plus built-ins `image_resize` and `onnx.nudenet`. `offload::base_capability(cap)` strips bracket attributes; `parse_capabilities_with_prefix(raw, prefix)` yields `CapabilityInfo { base, tags }`.

**External resize** (`services/external_resize.rs`): uploads over `EXTERNAL_RESIZE_THRESHOLD_BYTES` (9 MiB) are stored verbatim because `process_image` skips local decode above `MAX_TRANSCODE_BYTES`/`MAX_TRANSCODE_EDGE`. Rather than shipping a 48 MP original to an expensive agent, a cheap `image_resize` pre-step task shrinks it and **its output bucket becomes the real task's input bucket** — the bytes never round-trip through OAI.

---

## Database

SeaORM with PostgreSQL 17. Migrations run automatically on startup via `db::connect()`. All IDs are snowflake `i64` — never serial/autoincrement.

### Tables

| Table | Key columns |
|-------|-------------|
| `users` | `id` (i64 PK), `login` (unique), `password_hash`, `google_id`, `is_admin`, `used_storage_bytes`, `last_quotas_update_timestamp` |
| `app_settings` | single row (id=1): `offloadmq_url`, `client_api_token`, `management_api_token` |
| `chats` | `id`, `user_id`, `title`, `system_prompt`, `last_model`, timestamps |
| `chat_messages` | `id`, `chat_id`, `role`, `content`, `status` (complete/pending/failed), `model`, `offload_cap`, `offload_task_id` |
| `chat_attachments` | `id`, `user_id`, `message_id`, `chat_id`, `kind`, `filename`, `content_type`, `size_bytes`, `image_file_id`, `storage_path`, `sha256` |
| `prompt_entries` | `id`, `user_id`, `bucket`, `kind` (`recent`/`starred`), `content`, `last_used_at` |
| `llm_capabilities` / `imggen_capabilities` | `base` (PK text), `tags_json`, `raw`, `last_available_at` |
| `image_generation_jobs` | `id`, `user_id`, `status`, `display_name`, `prompt`, `negative_prompt`, `capability`, `workflow`, `width`, `height`, `seed`, `input_image_id`, `error`, `pipeline_params_json` |
| `image_files` | `id`, `user_id`, `job_id`, `direction`, `source`, `storage_path`, `thumbnail_storage_path`, `filename`, `content_type`, sizes/dimensions, `exif_orientation`, `rescaled`, `reencoded`, `sha256`, offload bucket/file uids |
| `image_pipeline_events` | `id`, `job_id`, `step`, `state`, `details` |
| `image_offload_tasks` | `id`, `job_id`, `offload_cap`, `offload_task_id`, `submit_payload`, last-poll fields, `submitted_at`, `started_at`, `finished_at`, `typical_runtime_seconds` |
| `image_worker_logs` | `id`, `run_id`, `level`, `message`, `data_json` |
| `generation_parameters` | `id`, `user_id`, `filename`, `source`, `parameters` |
| `image_analysis_jobs` | lifecycle cols + `prompt`, `capability`, `input_image_id`, `offload_bucket_uid`, `result`, `data_preparation`, `external_resize` |
| `nude_detect_jobs` | lifecycle cols + `threshold`, `input_image_id`, `offload_bucket_uid`, `result` |
| `tts_jobs` | lifecycle cols + `text`, `capability`, `voice`, `model`, `audio_storage_path`, `audio_content_type`, `audio_size_bytes` |
| `music_generation_jobs` | lifecycle cols + `tags`, `lyrics`, `bpm`, `duration`, `seed`, `language`, `keyscale`, `cfg_scale`, `temperature`, `output_bucket_uid`, `audio_files_json` |
| `img_utils_jobs` | lifecycle cols + `utility`, `workflow`, `input_image_id`, `source_image_id`, `options_json`, `output_bucket_uid`, `output_image_id`, `started_at`, `typical_runtime_seconds` |
| `llm_compare_jobs` | `id`, `user_id`, `status`, `system_prompt`, `user_prompt`, `slots_json`, `error` |
| `llm_debate_jobs` | models/systems for A/B/referee, `messages_json`, `phase`, `current_turn`, `offload_*`, `active_log` |
| `movie_jobs` | `idea`, size/scene knobs, `director_model`, `scene_model`, `txt2video_capability`, `img2video_capability`, `phase`, `outline_json`, `scenes_json`, `current_scene`, `movie_file_id`, `offload_*` |

"Lifecycle cols" = `id, user_id, created_at, updated_at, status, stage, error, offload_cap, offload_task_id` — the shape `db/offload_jobs.rs` operates on generically.

### Adding a Migration

Add a new `mod` inside `migrator.rs` and push a `Box::new(...)` to the `migrations()` vec. Naming convention: `m{YYYYMMDD}_{NNNNNN}_{description}` — the counter is global and sequential (latest: `m20260806_000032_image_analysis_external_resize`). Migrations run once on boot — always provide a `down()`.

---

## Background Workers

Twelve workers spawned in `main.rs`. Ten run on `jobs::worker_runtime` with a `WorkerConfig { label, tick_env, batch_env, default_tick_secs, default_batch_size }`; the two with custom loops keep their own.

| Worker | Default tick | Env overrides | Job |
|--------|--------------|---------------|-----|
| `image_pipeline_worker` (bespoke loop) | 20 s | `IMAGE_PIPELINE_WORKER_TICK_SECS` / `_BATCH_SIZE` | Polls submitted image jobs, downloads outputs, reconciles; writes per-run logs |
| `chat_worker` | 10 s | `CHAT_WORKER_TICK_SECS` / `_BATCH_SIZE` | Reconciles `status="pending"` assistant messages |
| `image_analysis_worker` | 10 s | `IMAGE_ANALYSIS_WORKER_*` | describe jobs |
| `nude_detect_worker` | 10 s | `NUDE_DETECT_WORKER_*` | nudenet jobs |
| `tts_worker` | 10 s | `TTS_WORKER_*` | tts jobs |
| `music_generation_worker` | 10 s | `MUSIC_GEN_WORKER_*` | txt2music jobs |
| `img_utils_worker` | 10 s | `IMG_UTILS_WORKER_*` | img-utils + image_resize jobs |
| `llm_compare_worker` | 10 s | `LLM_COMPARE_WORKER_*` | compare jobs |
| `llm_debate_worker` | 10 s | `LLM_DEBATE_WORKER_*` | debate turns |
| `movie_worker` | 10 s | `MOVIE_WORKER_*` | movie phases (outline → scene → concat) |
| `llm_capability_cleanup_worker` (bespoke loop) | 3600 s | `LLM_CAPABILITY_CLEANUP_TICK_SECS` | Deletes stale LLM capability rows |
| `stale_job_reaper` | 3600 s | `STALE_JOB_REAPER_TICK_SECS`, `STALE_JOB_REAPER_MAX_AGE_HOURS` (24) | Fails jobs stuck non-terminal past the age threshold, all tables |

Every worker tolerates OffloadMQ being down — the pass returns `Err`, the runtime logs a warning and ticks again.

---

## Storage

`AppState.storage: Option<Operator>`. `STORAGE_BACKEND` defaults to `fs` when unset or empty; `None` only when explicitly `none`/`disabled` (upload/download routes then fail).

| `STORAGE_BACKEND` | Vars needed |
|-------------------|-------------|
| `fs` \| `local` (default) | `STORAGE_FS_ROOT` (default `./.data/storage`) |
| `s3` | `STORAGE_S3_ENDPOINT`, `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` |
| `none` \| `disabled` | — storage off |

`services::storage::operator(state)` returns `Result<&Operator, AppError::Internal>` — use it at the top of any handler that needs file I/O, then `read` / `write` / `exists` / `delete`.

Blob paths are **not** hand-formatted — use `services::image_paths`:

| Helper | Path |
|--------|------|
| `main_image_path(user, direction, job_id, image_id)` | `users/{u}/images/output/{job}/{id}.jpg` or `users/{u}/images/input/{id}.jpg` |
| `standalone_output_path(user, image_id)` | outputs with no `image_generation_jobs` row (img-utils) |
| `thumbnail_path` / `starred_image_path` | derived variants |
| `video_output_path(user, job, file, filename)` / `movie_output_path(user, job, file)` | video + final movie blobs |

Chat documents live at `users/{uid}/chat_docs/{attachment_id}.{ext}`.

---

## Admin Settings

`app_settings` is a DB singleton (id=1). Seeded on first boot from `OFFLOAD_MQ_CLIENT_KEY` / `OFFLOAD_MQ_MGMT_TOKEN` env vars if those columns are null. After that, changes go through `POST /api/admin/settings`. Always call `app_settings::get(&state.db).await?` fresh — no caching.

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
Box::new(m20260806_000033_my_change::Migration),

mod m20260806_000033_my_change {
    use sea_orm_migration::prelude::*;
    pub struct Migration;
    impl MigrationName for Migration {
        fn name(&self) -> &str { "m20260806_000033_my_change" }
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
