# Plan: make OAI chat stateless & background-processed

Goal: chat completions must keep running and persist their result when the user
navigates away, closes the tab, or the backend pod restarts — exactly like image
generation already does. No per-connection in-memory state may be the source of
truth.

## Current state (why chat is not stateless)

- `services/chat.rs::run_chat` persists the user message, submits the offload
  task, then `tokio::spawn`s an in-memory `poll_loop` bound to the WebSocket
  `tx`. The assistant reply is only persisted when that loop sees a terminal
  status.
- `poll_loop` returns early when the WS receiver is dropped during the *progress*
  phase (`chat.rs:168-170`) → if the user leaves mid-generation the reply is
  **never persisted**.
- `chat_messages` has no offload-task columns, so a restarted/!connected backend
  has no record to reconcile. Pod restart loses every in-flight chat.

Image generation is the reference design and is already correct:
`image_generation_jobs` + `image_offload_tasks` rows advanced by
`jobs/image_pipeline_worker.rs` → `image_jobs::run_background_reconcile_pass`,
which runs on a timer regardless of any client. We mirror it for chat.

## Design

Persist a `pending` assistant message with its offload task id at submit time.
A DB-driven background worker reconciles all `pending` assistant messages. The
WS poll loop stays only as a *best-effort live stream* for the connected client;
it is no longer the source of truth. Finalization is idempotent so the loop and
the worker can race safely.

## Changes

### 1. Migration — `m20260522_000008_add_chat_message_offload_fields`
Add to `migrator.rs` (`migrations()` vec + new module). Add nullable columns to
`chat_messages` (backward-compatible):
- `offload_cap TEXT NULL`
- `offload_task_id TEXT NULL`
- `stage TEXT NULL`
- `log TEXT NULL`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
Index: `idx_chat_messages_status` on `(status)` for the worker scan.
New status value `pending` joins existing `complete` / `failed` (no schema
change needed for the enum-as-text).

### 2. Entity — `db/entities/chat_messages.rs`
Add the five fields to `Model` (Options for the nullable ones). Update doc
comment: status now `pending | complete | failed`.

### 3. `db/chats.rs`
- `add_pending_assistant_message(db, id, chat_id, model, offload_cap, offload_task_id)`
  → inserts row `role=assistant`, `status=pending`, `content=""`.
- `finalize_message(db, id, content, status) -> rows_affected` → updates
  `content/status/updated_at WHERE id=? AND status='pending'` (idempotent guard).
- `update_message_stage(db, id, stage, log)` → progress, also bumps `updated_at`.
- `list_pending_assistant_messages(db, limit)` → `status='pending'` AND
  `offload_task_id IS NOT NULL`, oldest-first, limited (worker batch).
- `add_message` keeps its current signature for user/system messages.

### 4. `services/chat.rs` (refactor)
- `run_chat`: after `submit_chat`, create the assistant row via
  `add_pending_assistant_message` (carrying `task_id.cap` / `task_id.id`). Send
  `TaskQueued`. Spawn `poll_loop` as today for live UX.
- `poll_loop`: on terminal status call the idempotent `finalize_message`
  (instead of `add_message`). On WS-send failure **do not return** — keep polling
  so the reply still finalizes; only stop emitting events. (Worker is the backstop
  for pod restart.)
- Add `run_background_reconcile_pass(state, batch)`:
  - `list_pending_assistant_messages(batch)`; for each, build `TaskId{cap,id}`,
    `client.poll_task`; map completed→`finalize complete`, failed/canceled→
    `finalize failed`, else `update_message_stage`.
  - Deadline: if `now - created_at > MAX (≈10 min)` and still pending → finalize
    failed "timed out", matching current `MAX_POLLS`.

### 5. Worker — `jobs/chat_worker.rs` + `jobs/mod.rs`
Clone `image_pipeline_worker.rs`: tick (env `CHAT_WORKER_TICK_SECS`, default 10s),
batch (`CHAT_WORKER_BATCH_SIZE`, default 20), call
`chat::run_background_reconcile_pass`. `spawn(state)` from `main.rs` next to the
image worker.

### 6. Frontend — `oai/frontend`
- Chat view renders `status==="pending"` assistant messages with a spinner
  (data already comes from `GET /api/chats/:id/messages`).
- On chat load / WS reconnect, if any message is `pending`, poll
  `GET /api/chats/:id/messages` every ~2.5s until none are pending (the WS
  `req_id`-keyed live events can't be resumed after reload, so polling is the
  reliable resume path). Live send path is unchanged.

### 7. Statelessness audit (confirm, no expected changes)
- `AppState` holds only DB pool, auth, snowflake, storage op, http client — all
  shareable/stateless. No in-memory per-user/session maps outside the WS task.
- Image path already DB-backed → OK.
- After this change, the only in-memory state (WS poll loop) is non-authoritative,
  so multiple replicas and restarts are safe. (Two replicas may double-poll a
  task; harmless and idempotent. Optional later: `SELECT ... FOR UPDATE SKIP
  LOCKED` claim if we scale out.)

## Rollout
1. `cd oai/backend && cargo build` (compile + entity/migration check); `cargo test`.
2. `cd oai/itests && uv run pytest` against a local backend (`task dev`).
3. `cd oai/frontend && npm run build` / `npm run lint`.
4. Commit (image tag = git hash), then `task ship` (docker:release → deploy).
   Migration auto-runs on startup; nullable-column adds are safe & online.
5. Verify: start a chat, close the tab mid-generation, reopen → reply present;
   `kubectl delete pod` the app mid-generation → reply still finalizes.

## Risk / notes
- Migration is additive & backward-compatible; old rows get `pending`-free
  defaults. Safe to roll back the image (columns simply go unused).
- Idempotent `finalize_message` (WHERE status='pending') prevents the loop and
  worker from writing the reply twice.
- No change to image generation (already compliant).
