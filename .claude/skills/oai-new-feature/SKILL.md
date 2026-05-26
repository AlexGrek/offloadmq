---
name: oai-new-feature
description: >-
  Blueprint for building a new "AI app" feature inside OAI (chat-, image-gen-,
  image-analysis-style). Covers the common end-to-end flow: DB schema, SeaORM
  migration/entity, service layer, route group, background reconcile worker,
  frontend API client, history sidebar, new-panel + job-detail layout. Use when
  adding a new user-facing AI feature backed by OffloadMQ tasks (anything that
  submits a task, persists history, polls, cancels, retries, deletes). Always
  add documentation; use oai-frontend for SPA work; consult the OffloadMQ task
  API docs listed below.
---

# OAI — Building a New AI Feature

OAI exposes "AI apps" to end users (Chat, Image Generation, Image Analysis). Each is a thin local CRUD layer wrapping an OffloadMQ background task — same shape end-to-end. Use this skill as the blueprint when adding a new app of the same family.

Stack this skill with:
- **oai-frontend** — for every SPA file you touch. Read it before editing `oai/frontend/**`.
- **oai-backend** — for cross-cutting backend patterns (router groups, middleware, AppState).
- **oai-devops** — only when adding env vars, migrations that affect deploy, or new Helm bits.
- **oai-itests** — when writing Python integration tests for new routes.

The two reference implementations are:
- **Image generation** — `services/image_jobs.rs`, `routes/images.rs`, `jobs/image_pipeline_worker.rs`, `pages/ImageGenerationPage.tsx`, `components/imggen/ImageJobHistorySidebar.tsx`.
- **Image analysis** — `services/image_analysis.rs`, `routes/describe.rs`, `jobs/image_analysis_worker.rs`, `pages/DescribeImagePage.tsx`, `components/describe/DescribeHistorySidebar.tsx`.

Read both before designing a new feature; copy the simpler one (`image_analysis`) unless your feature produces output *files* (use `image_jobs` then).

---

## The Common Feature Shape

Every AI app in OAI has the same five pieces. Build them in this order:

```
        ┌───────────────────────────────────────────────────────────────┐
        │  React SPA                                                    │
        │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐   │
        │  │ HistorySidebar│ │ "New" panel  │  │ Job-detail panel   │   │
        │  └─────────────┘  └──────────────┘  └────────────────────┘   │
        └───────────────────────────────────────────────────────────────┘
                          │  fetch / poll       ▲
                          ▼                     │ JSON
        ┌───────────────────────────────────────────────────────────────┐
        │  Rust/Axum backend (routes/<feature>.rs)                      │
        │  thin handler → services/<feature>.rs domain logic            │
        └───────────────────────────────────────────────────────────────┘
              │                                  ▲
              ▼                                  │
        ┌─────────────────┐               ┌──────────────────────┐
        │ Postgres (jobs) │               │ Background worker    │
        │ + storage (S3)  │               │ jobs/<feature>_worker│
        └─────────────────┘               └──────────────────────┘
                   ▲                                │
                   └─────── reconcile ──────────────┘
                                │
                                ▼
                       OffloadMQ HTTP API
```

---

## 1. DB schema (one job table is enough)

If your feature produces **text** or **structured JSON** output → use a single `*_jobs` table with a `result` column. See `image_analysis_jobs`.

If your feature produces **files** (images, audio) → use 3 related tables: `*_jobs`, `*_files`, `*_pipeline_events` plus an `*_offload_tasks` table for the linked OffloadMQ task. See `image_generation_jobs` + friends.

**Column checklist for the jobs table:**

```text
id              big_integer  PK (snowflake; never auto_increment)
user_id         big_integer  FK → users(id), on_delete cascade
created_at      timestamptz  default now()
updated_at      timestamptz  default now()
status          text         default 'created'
                             values: created → submitted → pending → running →
                             [completed | failed | canceled | cancelRequested]
prompt          text
capability      text          OffloadMQ capability base, e.g. "llm.qwen3:8b"
offload_cap     text  null    set when task is submitted
offload_task_id text  null    set when task is submitted
result          text  null    populated on completion (or use *_files for outputs)
stage           text  null    optional sub-step name from OffloadMQ polls
error           text  null    populated on failure
```

Plus any feature-specific params (input image id, dimensions, model knobs, …).

**Indexes**: `(user_id)` for list queries, `(status)` for the background worker's pending-jobs query.

**Migration**: append a new module to `migrator.rs` named `m<YYYYMMDD>_<NNNNNN>_create_<feature>_jobs`; add `Box::new(...)` to `migrations()`. Pattern after `m20260522_000016_create_image_analysis_jobs`.

**Entity**: one file in `db/entities/<feature>_jobs.rs`. Register in `db/entities/mod.rs`. SeaORM model only — no relations needed for the simple shape.

---

## 2. DB module (`db/<feature>.rs`)

Pure data access — no business logic, no OffloadMQ calls. Mirror `db/image_analysis.rs`:

```rust
pub async fn create_job(db, NewJobInput) -> Result<Model>
pub async fn get_job(db, job_id, user_id) -> Result<Option<Model>>
pub async fn list_jobs(db, user_id, limit) -> Result<Vec<Model>>
pub async fn delete_job(db, job_id, user_id) -> Result<()>
pub async fn set_offload_task(db, job_id, cap, task_id, ...) -> Result<()>
pub async fn update_status(db, job_id, status, stage, error) -> Result<()>
pub async fn set_result(db, job_id, result) -> Result<()>
pub async fn list_jobs_for_background_worker(db, limit) -> Result<Vec<Model>>
```

The background worker query is required — it must return all non-terminal jobs ordered by `updated_at ASC` so older in-flight jobs are reconciled first.

Register in `db/mod.rs`.

---

## 3. Service layer (`services/<feature>.rs`)

This is the **only** layer that talks to OffloadMQ. Routes never construct OffloadMQ clients directly.

**Required public functions:**

```rust
pub async fn list_capabilities(state) -> Result<Vec<Cap>>   // filter offload_factory output
pub async fn start_job(state, user_id, params) -> Result<job_id>
pub async fn poll_job(state, user_id, job_id) -> Result<Job>
pub async fn cancel_job(state, user_id, job_id) -> Result<Outcome>
pub async fn retry_job(state, user_id, job_id) -> Result<new_job_id>
pub async fn delete_job(state, user_id, job_id) -> Result<()>
pub async fn list_user_jobs(state, user_id, limit) -> Result<Vec<Job>>
pub async fn user_job_detail(state, job_id, user_id) -> Result<Detail>

// Worker entry point — called by jobs/<feature>_worker.rs
pub async fn run_background_reconcile_pass(state, batch_size) -> Result<()>
```

**`start_job` flow (verbatim):**

1. Validate input (`prompt` non-empty, `capability` non-empty/prefix match).
2. Persist a row with `status="created"` (snowflake id from `state.next_id()`).
3. Build OffloadMQ client via `offload_factory::chat_client(state)` or `image_client(state)`.
4. (If input file) `create_bucket(true)` + `upload_bucket_file(...)`.
5. Submit via `submit_chat` / `submit_vision_task` / `submit_img_task`.
6. `set_offload_task(...)` → status flips to `"submitted"`.
7. Return job id.

**`poll_job` flow:**

1. Load job. If `is_terminal(status)` → return as-is.
2. Build client. Call `client.poll_task(...)`.
3. Map OffloadMQ poll status → DB status. On `"completed"` extract result and call `set_result`. On `"failed"` extract error message and call `update_status(... "failed" ...)`.
4. On poll error: detect "task missing" (404/410) via `offload_task_missing_message(err)` and mark the job failed locally; otherwise propagate.

**Always copy these helpers verbatim from `services/image_analysis.rs`:**
- `is_terminal(status)` — terminal status check
- `extract_llm_text(output)` — LLM output extractor (Ollama + OpenAI shapes)
- `extract_error_text(output)` — error extractor
- `offload_task_missing_message(err)` — 404/410 detector
- `offload_http_is_task_missing(rest)` — http code matcher

Register in `services/mod.rs`.

---

## 4. Background worker (`jobs/<feature>_worker.rs`)

Wakes every ~10 s, calls `services::<feature>::run_background_reconcile_pass(state, batch_size)`, logs warnings on failure (never panic — OffloadMQ being down must not crash the worker).

Wire in two places:
- `jobs/mod.rs` — `pub mod <feature>_worker;`
- `main.rs` — `jobs::<feature>_worker::spawn(state.clone());`

Add two env vars (optional): `<FEATURE_UPPER>_WORKER_TICK_SECS`, `<FEATURE_UPPER>_WORKER_BATCH_SIZE`. Defaults: 10 s tick, 20 batch. Document them in `oai-devops`.

---

## 5. Routes (`routes/<feature>.rs`)

Thin handlers. Each handler: parse path params → call one service function → map to a DTO `Serialize` struct → return `Json`.

Use snake_case in the DTOs (matches the rest of the OAI API).

**Standard route set:**

```text
GET    /api/<feature>/capabilities          → list_capabilities
POST   /api/<feature>/jobs                  → start_job
GET    /api/<feature>/jobs                  → list_jobs
GET    /api/<feature>/jobs/{id}             → get_job
POST   /api/<feature>/jobs/{id}/poll        → poll_job
POST   /api/<feature>/jobs/{id}/cancel      → cancel_job
POST   /api/<feature>/jobs/{id}/retry       → retry_job
DELETE /api/<feature>/jobs/{id}             → delete_job
```

Register in `app.rs` inside the `authenticated` router group (so JWT middleware runs).

**Input image upload**: reuse the existing `POST /api/images/upload` endpoint. It returns an `image_id` (i64 as string) that any feature can pass back via the start-job request body. **Do not** add a per-feature upload endpoint — store input files via `image_generation::create_image_file` and reference by id.

---

## 6. Frontend API client (`oai/frontend/src/api/<feature>.ts`)

Mirror `api/describe.ts`. Plain functions returning typed promises. Use the shared `request<T>(path, token, options)` pattern with `Authorization: Bearer <token>`. JSON bodies are stringified; FormData is detected and passed through.

Export typed interfaces for every DTO the backend returns. Keep these names in sync with the backend `Serialize` structs (snake_case fields).

---

## 7. UI — three pieces

**Page** (`pages/<Feature>Page.tsx`): split layout — sidebar + main column.

**History sidebar** (`components/<feature>/<Feature>HistorySidebar.tsx`):
- Top: "New" pill (sets `activePanel = 'new'`)
- List: jobs as cards (thumbnail bg if input image, dimmed overlay, prompt as title, model as monospace meta, status pill)
- Selection state is the *string* `activePanel` — either `'new'` or a job id (no separate boolean)

**Main column** has two modes:
- `activePanel === 'new'` → form (capability picker, image upload, prompt, submit)
- otherwise → job detail (image, meta, actions: Edit prompt / Retry / Poll now / Cancel / auto-poll indicator, then prompt and result)

**Auto-polling**: `useEffect` interval (~3 s) while viewing a non-terminal job. Stop when status enters `{completed, failed, canceled}`. Clear the interval in cleanup.

**Markdown rendering**: pipe text results through `<MarkdownContent>` (handles GFM, code blocks, links).

**Reuse**: `imageThumbnailUrl(image_id, token, revision)` and `imageFileUrl(...)` for input previews — they already exist in `api/images.ts`.

Stack the **oai-frontend** skill for the SPA work. It owns AppShell layout, dark/light, routing, shadcn/ui patterns.

---

## 8. Routing

Add the route in `oai/frontend/src/App.tsx` under `/app/<feature>` and add a sidebar entry in `AppShell.tsx`'s nav list.

---

## Documentation (required)

After implementing a feature, **always update documentation**:

1. **Add an entry to the project `CLAUDE.md`** under the OAI section if the feature introduces new routes or significant UI patterns.
2. **Bump or create the relevant skill**: if your feature is large enough to need its own context, write a sibling skill at `.claude/skills/oai-<feature>/SKILL.md` (model on `oai-chat` / `oai-img`) and add it to the activation matrix in `CLAUDE.md`.
3. **Document new env vars** in `oai-devops` skill and the `oai/backend/.env.example` if one exists.
4. **Document the public API** under `docs/`. New OffloadMQ-touching features go beside `docs/integration-guide-llm.md`.

If you skip docs, the next agent will be unable to find the feature without re-reading the code — defeating the purpose of skills.

---

## OffloadMQ task API — where the docs live

The OffloadMQ server is in the same repo (root). Reference these whenever you need to know what fields a task accepts/returns:

| Topic | File |
|-------|------|
| Client task submit / poll / cancel | `docs/tasks-api.md` (Client API section) |
| Agent-side task pickup | `docs/tasks-api.md` (Agent API section) |
| File buckets (input/output) | `docs/client-storage-api.md` |
| Management / admin endpoints | `docs/management-api.md` |
| **LLM integration end-to-end** (vision, files, polling) | `docs/integration-guide-llm.md` ← read first for any LLM/vision feature |
| ComfyUI image-gen API | `docs/comfy-api.md` |
| Custom capabilities (declare new task types) | `docs/custom-capabilities.md` |
| Capability semantics + bracket attributes | `docs/agent-capabilities.md` |
| Slavemode / direct CLI invocation | `docs/slavemode-capabilities.md` |

The local-dev API keys are in the project `CLAUDE.md` — never grep `.env`.

For HTTP-level reference: the Rust route handlers in `src/api/client/mod.rs` and `src/api/agent/mod.rs` are the source of truth. Look there if `docs/` is ambiguous.

---

## Pre-flight checklist before opening a PR

- [ ] Migration adds the new table and is registered in `migrator.rs::migrations()`.
- [ ] Entity is registered in `db/entities/mod.rs`.
- [ ] `db/mod.rs` exports the new data-access module.
- [ ] `services/mod.rs` exports the service; `routes/<feature>.rs` is in `routes/mod.rs`.
- [ ] Worker is spawned in `main.rs`.
- [ ] `cargo check` passes from `oai/backend/`.
- [ ] Frontend builds: `npx tsc --noEmit` from `oai/frontend/`.
- [ ] Sidebar item added to `AppShell` nav.
- [ ] Auto-poll stops on terminal statuses (no runaway timers).
- [ ] `delete_job` removes job-linked storage blobs (if any) before the DB row.
- [ ] Docs updated (see "Documentation" above).
