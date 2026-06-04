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

**The four simple features run on a shared framework — use it, don't re-duplicate.** A new submit→poll→persist feature should reuse `db/offload_jobs.rs`, `services/offload_job.rs`, `offload/task_status.rs`, `jobs/worker_runtime.rs`, and `routes/job_common.rs`, implementing only its unique logic (two trait impls + `start_job` + the completed-result handler). See **"Use the shared framework"** below.

Reference implementations, simplest first — copy the closest match:
- **TTS** (no input file, audio blob output) — `db/tts.rs`, `services/tts.rs`, `routes/tts.rs`, `jobs/tts_worker.rs`, `pages/TtsPage.tsx`.
- **Image analysis / nude detect** (input image → text/JSON result) — `db/image_analysis.rs`, `services/image_analysis.rs`, `routes/describe.rs`.
- **Music generation** (output *files* from an OffloadMQ bucket, image-client poller) — `db/music_generation.rs`, `services/music_generation.rs`, `routes/music_generation.rs`.
- **Image generation** — `services/image_jobs.rs` etc. is the *bespoke* multi-file pipeline (NOT on the framework); only copy it if you need pipeline events + multiple output files + an offload-tasks table.

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

## 2. DB module (`db/<feature>.rs`) — wire into the generic ops, don't re-write them

The lifecycle reads/writes (`get_job`, `list_jobs`, `delete_job`, `update_status`,
`set_offload_task`, `list_jobs_for_background_worker`) are **generic** in
`db/offload_jobs.rs` — do NOT re-implement them per feature. Your `db/<feature>.rs`
contains only:

1. `pub type <Feature>Job = <feature>_jobs::Model;` alias.
2. `impl OffloadJobModel for <feature>_jobs::Model` — `id`, `status`, `offload_cap`, `offload_task_id`.
3. `impl OffloadJobEntity for <Entity>` — the `col_*()` accessors (and `col_bucket()` ⇒ `Some(...)` if the table has a bucket column; default `None` otherwise).
4. `create_job(db, NewJobInput)` — the only feature-specific insert.
5. result setter(s) — `set_result` (text/JSON), `set_audio` / `set_audio_files`, etc.

Mirror `db/tts.rs` (no bucket) or `db/image_analysis.rs` (with bucket). Then call the
generic ops with a turbofish, e.g. `offload_jobs::get_job::<<Feature>Entity>(...)`.

Register in `db/mod.rs`. The generic worker query returns all non-terminal jobs
ordered by `updated_at ASC` (older in-flight jobs reconciled first).

---

## 3. Service layer (`services/<feature>.rs`) — implement `JobReconciler`, delegate the rest

This is the **only** layer that talks to OffloadMQ. Routes never construct OffloadMQ
clients directly. The poll/cancel/reconcile state machine is generic
(`services/offload_job.rs`); you implement one trait + the genuinely unique functions.

**Implement `JobReconciler` on a zero-sized marker** (mirror `services/tts.rs`):

```rust
struct <Feature>Reconciler;

#[async_trait]
impl JobReconciler for <Feature>Reconciler {
    type Entity = <Feature>Entity;
    fn label(&self) -> &'static str { "<feature>" }
    fn failure_fallback(&self) -> &'static str { "<feature> task failed" }
    async fn poller(&self, state) -> Result<Box<dyn OffloadPoller>> {
        Ok(Box::new(offload_factory::chat_client(state).await?))   // or image_client for bucket output
    }
    async fn on_completed(&self, state, job: &Model, poll: &NormalizedPoll) -> Result<()> {
        // the ONLY varying branch: extract result from poll.output and persist it
        // (set_result / download bucket files → set_audio_files / decode base64 → set_audio).
        // failed / canceled / in-progress are handled by the driver.
    }
}
```

**Then write the feature-specific functions** (everything else is a thin delegate):

```rust
pub async fn list_capabilities(state) -> Result<Vec<Cap>>            // filter offload_factory output
pub async fn start_job(state, user_id, params) -> Result<job_id>     // validate → create_job → submit → set_offload_task
pub async fn retry_job(state, user_id, job_id) -> Result<new_id>     // reload params, re-call start_job

// thin wrappers over the generic driver / generic db ops:
pub async fn poll_job(...)  { offload_job::poll_job(&<Feature>Reconciler, ...).await }
pub async fn cancel_job(...) -> offload_job::CancelOutcome { offload_job::cancel_job(&<Feature>Reconciler, ...).await }
pub async fn run_background_reconcile_pass(...) { offload_job::reconcile_pass(&<Feature>Reconciler, ...).await }
pub async fn list_user_jobs(...) { offload_jobs::list_jobs::<<Feature>Entity>(...).await }
pub async fn user_job_detail(...) / delete_job(...)  // get_job/delete_job via offload_jobs, plus storage cleanup in delete
```

**`start_job` flow:**

1. Validate input (non-empty prompt/tags, `capability` prefix match).
2. `create_job(...)` with `status="created"` (snowflake id from `state.next_id()`).
3. Build client via `offload_factory::chat_client(state)` / `image_client(state)`.
4. (If input file) `create_bucket(true)` + `upload_bucket_file(...)`; (if output files) `create_bucket(false)`.
5. Submit via `submit_chat` / `submit_vision_task` / `submit_tts_task` / `submit_img_task`.
6. `offload_jobs::set_offload_task::<<Feature>Entity>(db, id, cap, task_id, bucket_opt)` → status `"submitted"`.
7. Return job id.

**Never re-copy the status helpers** — use `offload::task_status::{is_terminal,
extract_llm_text, extract_error_text, offload_task_missing_message}` and `OffloadPoller`.

Register in `services/mod.rs`.

---

## 4. Background worker (`jobs/<feature>_worker.rs`) — ~6 lines over `worker_runtime`

Delegate the tick loop + env parsing to `jobs/worker_runtime.rs`:

```rust
pub fn spawn(state: Arc<AppState>) {
    worker_runtime::spawn(
        state,
        WorkerConfig {
            label: "<feature>",
            tick_env: "<FEATURE_UPPER>_WORKER_TICK_SECS",
            batch_env: "<FEATURE_UPPER>_WORKER_BATCH_SIZE",
            default_tick_secs: 10,
            default_batch_size: 20,
        },
        |state, batch| async move { <feature>::run_background_reconcile_pass(&state, batch).await },
    );
}
```

Wire in two places:
- `jobs/mod.rs` — `pub mod <feature>_worker;`
- `main.rs` — `jobs::<feature>_worker::spawn(state.clone());`

Defaults: 10 s tick, 20 batch. Document the two env vars in `oai-devops`. (Only the
image-generation worker keeps a bespoke loop — it also writes per-run logs.)

---

## 5. Routes (`routes/<feature>.rs`)

Thin handlers. Each handler: parse path params → call one service function → map to a DTO `Serialize` struct → return `Json`.

Use snake_case in the DTOs (matches the rest of the OAI API). Reuse the shared bits
from `routes/job_common.rs` — `parse_id(value, field)`, `StartJobResponse::submitted(id)`
(for start + retry), and `CancelJobResponse::from(outcome)` (`Ok(Json(out.into()))`).
Only the feature's `StartJobRequest` and `JobDetailsResponse` are written per feature.

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

Mirror `api/describe.ts`. Plain functions returning typed promises. Import the shared
fetch helper — `import { apiRequest as request } from './http'` — do **not** re-declare a
local `request<T>`; `http.ts` already handles `Authorization: Bearer <token>`, JSON vs
FormData, `{ error }` unwrapping, and `204`. (Only `auth.ts` is separate: it's the
public, no-token client.)

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
- [ ] `db/mod.rs` exports the new data-access module; it impls `OffloadJobEntity` + `OffloadJobModel` and re-uses the generic ops (no hand-written `get_job`/`update_status`/etc.).
- [ ] `services/<feature>.rs` impls `JobReconciler`; poll/cancel/reconcile are thin delegates to `services::offload_job` (no copied status helpers).
- [ ] `services/mod.rs` exports the service; `routes/<feature>.rs` is in `routes/mod.rs` and reuses `routes::job_common`.
- [ ] Worker is a `worker_runtime::spawn(...)` config and is spawned in `main.rs`.
- [ ] `cargo check` passes from `oai/backend/`.
- [ ] Frontend API client imports `apiRequest` from `api/http.ts` (no local `request<T>`).
- [ ] Frontend builds: `npx tsc --noEmit` from `oai/frontend/`.
- [ ] Sidebar item added to `AppShell` nav.
- [ ] Auto-poll stops on terminal statuses (no runaway timers).
- [ ] `delete_job` removes job-linked storage blobs (if any) before the DB row.
- [ ] Docs updated (see "Documentation" above).
