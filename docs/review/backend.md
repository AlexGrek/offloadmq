# Backend Review — OffloadMQ Rust Server

Code review of the Rust message-queue backend (`src/`). Findings are grouped by
status. Line references are accurate as of commit `ec0bf23` and may drift; treat
them as starting points, not guarantees.

## Fixed

These were addressed directly (see `git log`):

1. **Race in `UrgentTaskStore::assign_task` clobbered a prior assignment.**
   `entry.assigned_task` was written *before* the `status == Pending` check, so a
   losing racer (or a stale/retried `take`) overwrote the real winner's
   assignment while still returning `false`. Now the assignment only happens
   inside the `Pending` guard. — [src/mq/urgent.rs](../../src/mq/urgent.rs)

2. **Assigned urgent tasks never expired → blocking client hung forever.**
   `expire_tasks` only removed `Pending` entries; once a task became `Assigned`
   the 60 s TTL no longer applied, so an agent that died after pickup left the
   `submit_urgent_task` watcher waiting indefinitely. Added a `last_update`
   timestamp (set on assignment and every progress update) and expire in-flight
   tasks after TTL of agent silence. — [src/mq/urgent.rs](../../src/mq/urgent.rs)

3. **`rm_after_task` bucket validation TOCTOU.** Two concurrent submissions could
   both pass the "bucket unused" check before either recorded its task id,
   defeating the single-use invariant. Added `AppState::bucket_submit_lock`
   (a `tokio::sync::Mutex`) held across validate + record in both submit paths.
   — [src/state/mod.rs](../../src/state/mod.rs),
   [src/api/client/service.rs](../../src/api/client/service.rs)

4. **Sled `flush()` called synchronously inside async handlers.** Blocking
   `fsync` on the executor thread (on the per-poll agent-heartbeat hot path,
   plus every bucket write) was replaced with `flush_async().await`. The
   affected storage methods are now `async`. — [src/db/agent.rs](../../src/db/agent.rs),
   [src/db/bucket_storage.rs](../../src/db/bucket_storage.rs) (callers updated
   throughout the API layer).

## Open — High

### H1. Agents self-report their tier with no server-side bound
[src/api/agent/service.rs](../../src/api/agent/service.rs) — `do_update_agent_info`
sets `agent.tier = req.tier` (and `do_register_agent` accepts it from
registration) with no validation. The scheduler reserves tasks for the highest
online tier ([src/mq/scheduler.rs](../../src/mq/scheduler.rs),
`find_assignable_non_urgent_tasks_with_capabilities_for_tier`): if any agent
claims `tier = 255`, every lower-tier agent skips all tasks for that capability.
**Failure mode:** queue starvation / DoS triggerable by any registered agent.
**Fix direction:** clamp/validate tier against an allowed range tied to the
registration key, or derive tier server-side instead of trusting the client.

### H2. `report_non_urgent_task` is read-modify-write without CAS
[src/mq/scheduler.rs](../../src/mq/scheduler.rs) — loads the assigned task,
mutates it in memory, then `update_assigned` (a blind `insert`). A concurrent
`cancel` that flips status to `CancelRequested` between the read and the write is
silently overwritten by a later progress/result report. The `assign_task` move
itself is atomic (`Tree::remove` returns the old value), but post-assignment
updates are not. **Failure mode:** lost cancellation; a cancelled task reports
`Completed`. **Fix direction:** use `Tree::compare_and_swap` or a per-task lock
around the read-modify-write.

### H3. `do_cancel_task` cannot cancel urgent tasks
[src/api/client/service.rs](../../src/api/client/service.rs) — only inspects the
persistent `tasks` trees (assigned + unassigned). Urgent tasks live in
`state.urgent` and are invisible to this path, so cancelling an urgent task
returns `NotFound`. The only way to abort a blocking call is dropping the HTTP
connection. **Fix direction:** check `state.urgent` first and mark the urgent
entry `CancelRequested` (the urgent store already honours that status in
`complete_task` / `update_task`).

### H4. `count_buckets_for_key` enforcement is TOCTOU
[src/api/client/storage.rs](../../src/api/client/storage.rs) — `create_bucket`
reads `current`, compares to `max_buckets_per_key`, then creates. Two concurrent
creates can both pass and exceed the cap. Lower impact than H1–H3 (the limit is a
soft ceiling), but it shares the same shape as the fixed `rm_after_task` race and
could reuse `bucket_submit_lock`.

## Open — Medium

### M1. Agent file upload skips path sanitization that the client path performs
[src/api/agent/mod.rs](../../src/api/agent/mod.rs) (`upload_to_bucket` and the WS
`upload_file` action) stores `field.file_name()` directly as `original_name`,
whereas the client path runs `sanitize_upload_path`
([src/api/client/storage.rs](../../src/api/client/storage.rs)). Storage paths use
`file_uid`, so this is **not** a server-side traversal — but a compromised agent
can feed `../../etc/passwd` as `original_name` to any downstream consumer that
reconstructs files from it. **Fix direction:** apply the same sanitizer to agent
uploads.

### M2. `capability_attrs` accepts malformed bracket syntax silently
[src/utils.rs](../../src/utils.rs) — `find('[')` + `rfind(']')` parses
`"cap[a]extra[b]"` as the attr string `"a]extra[b"`. `base_capability("[evil")`
returns `""`, which then participates in capability matching as the empty string.
Harmless today, but if extended attributes ever gate authorization (hinted at in
CLAUDE.md) this becomes exploitable. **Fix direction:** reject capabilities with
unbalanced/duplicate brackets at registration and submission.

### M3. `expire_tasks` holds the outer write lock across N inner status reads
[src/mq/urgent.rs](../../src/mq/urgent.rs) — the `tasks.write()` guard is held for
the whole scan while awaiting each entry's `status.read()`. No deadlock (lock
order is consistent), but the GC pass blocks every poll and assignment for its
duration. Fine at small queue sizes; pathological at scale. **Fix direction:**
snapshot the ids/statuses under a read lock, then take the write lock only to
remove.

### M4. Urgent task selection is first-match, not fair
[src/mq/urgent.rs](../../src/mq/urgent.rs) — `find_with_capabilities` returns the
first `IndexMap` match (insertion order). An aggressive poller always grabs the
head task and can starve other equally-capable agents. The non-urgent path uses
`rand::choose` for fairness
([src/api/agent/service.rs](../../src/api/agent/service.rs)); urgent does not.

## Open — Low

### L1. `rx.changed().await.unwrap()` is a latent panic
[src/mq/scheduler.rs](../../src/mq/scheduler.rs) — in `submit_urgent_task`. Safe
today only because the local `state: Arc<TaskState>` keeps the watch sender
alive. Any refactor that drops it early turns this into a server-side panic on a
request path. **Fix direction:** match `Err(_)` and return an error.

### L2. `bucket_uid` used as a capability token but logged verbatim
Several `info!` calls log raw `bucket_uid`s. The documented security model for
the agent bucket endpoints
([src/api/agent/mod.rs](../../src/api/agent/mod.rs)) is "unguessable UUIDs act as
capability tokens" — anyone with log access can replay them. **Fix direction:**
document the constraint explicitly or truncate/hash before logging.

### L3. `try_pick_up_urgent_task` returns `Conflict` for a benign state
[src/mq/scheduler.rs](../../src/mq/scheduler.rs) — if `assign_task` succeeds but
`get_assigned_task` then returns `None`, it returns `Conflict` instead of
`Ok(None)`. Coupled to the urgent-expiry path; low likelihood.

### L4. `rng.choose().unwrap()` on a length-checked Vec
[src/api/agent/service.rs](../../src/api/agent/service.rs) — guarded by
`all.len() > 0`, so safe, but `if let Some(..)` reads identically and removes the
`unwrap`.

## Notes on durability semantics

The persistent task store ([src/db/persistent_task_storage.rs](../../src/db/persistent_task_storage.rs))
never calls `flush()` — it relies on Sled's periodic background flush. Agent and
bucket storage previously force-flushed on every write; those flushes are now
`flush_async` (durability preserved, blocking removed). If write throughput
becomes a concern, consider whether per-write durability is actually required for
agent heartbeats (it likely is not) and drop those flushes to match the task
store.
