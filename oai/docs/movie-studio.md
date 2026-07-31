# Movie Studio API Contract

Multi-scene AI film generator at `/app/movie`. A "director" LLM expands a user idea into
an N-scene outline; then, scene by scene, a "scene director" (vision-capable) LLM writes a
video-generation prompt — optionally seeded with the previous scene's last frame for visual
continuity ("long-shot mode") — each prompt renders as a real clip through the existing
`imggen.*` video pipeline (see [comfy-api.md](../../docs/comfy-api.md)), and once every scene
has rendered, ffmpeg concatenates the clips into one movie file.

Backend: `oai/backend/src/services/movie.rs` (state machine), `services/movie_ffmpeg.rs`
(ffmpeg), `routes/movie.rs` (REST), `ws/movie.rs` (WebSocket transport), `db/movie.rs` +
`db/entities/movie_jobs.rs` (persistence), `jobs/movie_worker.rs` (background reconcile).

---

## Pipeline overview

```
idea ──director LLM──▶ outline (N lines) ──[approval gate]──▶ for each scene:
                                                                  scene-director LLM
                                                                  (+ optional seed frame)
                                                                    │
                                                                    ▼
                                                              video prompt
                                                                    │
                                                                    ▼
                                                        imggen video render (txt2video/img2video)
                                                                    │
                                                          long-shot? extract last frame ──▶ next scene
                                                                    │
                                                                (last scene)
                                                                    ▼
                                                          ffmpeg concat all clips ──▶ movie.mp4
```

Everything is driven by `reconcile_job`, a single re-entrant state-machine function called by
the WS watch loop (`watch_job_ws`, ~1s cadence), the page's own poll (`POST .../poll`), and the
background worker (`movie_worker`). It is a no-op while the job is terminal, `awaitingApproval`,
or `paused`.

---

## State machine

### `status`

| Status | Meaning |
|--------|---------|
| `running` | Actively being reconciled (by WS watch, page poll, or worker) |
| `awaitingApproval` | Outline generated; parked for user review (only when `auto_approve=false`) |
| `paused` | User called `stop`; invisible to the background worker until `resume` |
| `completed` | Movie assembled; `movie_file_id` set |
| `failed` | Terminal error; `error` set |
| `canceled` | User called `cancel` |

`completed` / `failed` / `canceled` are terminal (`task_status::is_terminal`).

### `phase`

| Phase | What `reconcile_job` does |
|-------|----------------------------|
| `director` | No offload task yet → submit one (director LLM turn), or if `expand_prompt=false`, synthesize the outline directly from `idea` (see below) with no LLM call. Task in flight → poll it; on completion, parse the outline and call `apply_outline_and_gate` (advance to `scene_prompt`/`running` if `auto_approve`, else park at `awaitingApproval`). |
| `scene_prompt` | If `current_scene` is past the last scene, advance to `assemble`. No offload task yet → build the scene-director request (full outline + this scene's outline line + previous scene's prompt for continuity, optionally + a seed frame) and submit an LLM or vision task. Task in flight → poll it; on completion, store the prompt on the scene and advance to `video`. |
| `video` | If the scene has no `imggen_job_id` yet → start an `imggen.*` job (`txt2video` or `img2video`, see Long-shot mode below). Job exists → poll it via `image_jobs::poll_job`; on completion, record `video_file_id`, mark the scene `completed`, and — in long-shot mode, unless this is the last scene — extract the clip's last frame via ffmpeg and store it as `last_frame_image_id`. Then either advance to the next scene (back to `scene_prompt`) or, if this was the last scene, advance to `assemble`. |
| `assemble` | Read every scene's clip bytes from storage, `ffmpeg concat` them into one movie, generate a thumbnail, write both to storage, create the `image_files` row, and set `status=completed`, `phase=done`. |

Two different kinds of offload task flow through `job.offload_cap`/`job.offload_task_id`
depending on phase: LLM turns for `director`/`scene_prompt`, and (for `video`) the current
scene's own `imggen_job_id` — a full nested `image_generation_jobs` job, not a raw offload
task id.

**Skipping the director LLM entirely:** if `expand_prompt=false`, `reconcile_director` never
submits an LLM task. It calls `split_or_repeat_idea(idea, scene_count)`: if `idea` has exactly
`scene_count` non-empty lines, each line becomes one scene; otherwise the whole idea is repeated
verbatim as every scene's outline entry.

---

## Approval gate

When `auto_approve=false`, the job parks at `status=awaitingApproval` immediately after the
director outline is produced (or synthesized), with `phase` still `director`.

`POST /api/movie/jobs/{id}/approve`:
- Fails with 400 unless `job.status == "awaitingApproval"`.
- `outline` in the body is optional. If provided, it **must have exactly `scene_count` items**
  or the request is rejected with 400 (`outline must have exactly {n} scenes`). If provided,
  it replaces the outline and rebuilds all `SceneRecord`s from scratch (`set_outline`).
- Always sets `phase=scene_prompt`, `current_scene=0`, `status=running` — i.e. approval jumps
  straight past `director` into the scene loop.

When `auto_approve=true`, this gate is skipped entirely — the director phase transitions
straight to `scene_prompt`/`running`.

---

## Stop / resume

`POST /api/movie/jobs/{id}/stop`:
- Rejected (400) if the job is already terminal, or already `awaitingApproval`/`paused`.
- Best-effort cancels whatever offload work is in flight (`cancel_inflight_task`):
  - **`phase == "video"`** — cancels the *current scene's* `imggen` job via
    `image_jobs::cancel_job`.
  - **otherwise** (`director` / `scene_prompt`) — cancels the raw offload chat/vision task at
    `job.offload_cap`/`job.offload_task_id`.
- Clears `offload_cap`, `offload_task_id`, `active_log`, `stage`; sets `status=paused`.
- The scene records themselves are **not** touched by `stop`.

`POST /api/movie/jobs/{id}/resume`:
- Rejected (400) unless `job.status == "paused"`.
- If `phase == "video"` and the current scene's own status is **not** `"completed"`, that
  scene's `imggen_job_id` is cleared and its status reset to `pending` — so the render restarts
  from scratch (a fresh `imggen` job is submitted on the next reconcile). If the current scene
  is already `completed`, it is left untouched.
- Clears `offload_cap`, `offload_task_id`, `active_log`, `stage`; sets `status=running`.

**Guarantee:** scenes with `status == "completed"` are never regenerated by stop/resume — only
the in-progress scene (if any) is reset, and only if it hadn't finished rendering yet.

`POST /api/movie/jobs/{id}/cancel` is separate from stop: it also best-effort-cancels in-flight
work, but sets `status=canceled` (terminal) instead of `paused`, and is rejected only if the job
is already terminal.

---

## Retry

`POST /api/movie/jobs/{id}/retry` resubmits whatever stage failed, instead of forcing a full
restart of the movie:
- Rejected (400) unless `job.status == "failed"`.
- If `phase == "video"` or `phase == "scene_prompt"`, the current scene's `imggen_job_id` is
  cleared and its `status`/`error` reset to `pending`/`None` — a `director` failure needs no
  per-scene reset since that phase doesn't touch `scenes_json`, and `assemble` failures aren't
  scene-specific (the failing scene isn't necessarily `current_scene`).
- Clears `offload_cap`, `offload_task_id`, `active_log`, `stage`, `error`; sets `status=running`.
- The next reconcile (WS watch, page poll, or the background worker) resubmits the failed
  phase's offload task from scratch — completed earlier scenes are untouched, same guarantee as
  `resume`.

---

## Long-shot mode (`long_shot: bool`)

Per-scene frame seeding (`scene_frame_source`, used both to pick the scene-director's optional
vision frame and the video job's `img2video` input):

| Scene | Frame source | Video workflow |
|-------|--------------|-----------------|
| Scene 0 | `job.initial_image_id` if the user supplied one at submit time, else none | `img2video` if an initial image was supplied, else `txt2video` |
| Scene *i* > 0, `long_shot = true` | Previous scene's `last_frame_image_id` (from ffmpeg last-frame extraction) | `img2video` |
| Scene *i* > 0, `long_shot = false` | none | `txt2video` |

The same `frame_id` also becomes the scene-director LLM's vision input (`submit_vision_task`)
when present — so the vision model sees where the previous clip left off before writing the
next prompt.

**ffmpeg operations** (`services/movie_ffmpeg.rs`):

- **Last-frame extraction** (`last_frame_jpeg`) — run after each scene completes, skipped for
  the final scene and skipped entirely when `long_shot=false`:
  ```
  ffmpeg -hide_banner -loglevel error -sseof -0.3 -i <clip.mp4> -update 1 -q:v 2 -y <frame.jpg>
  ```
  `-sseof -0.3` seeks to 0.3s before end-of-file so the frame is guaranteed to land inside the
  stream; the output JPEG is verified as a valid JPEG before being stored as an `image_files`
  input row.

- **Concat** (`concat_videos`, run once in the `assemble` phase over every scene's clip, in
  order) — re-encodes rather than stream-copying, since clips come from separate ComfyUI runs
  with no guaranteed compatible codec parameters:
  ```
  ffmpeg -hide_banner -loglevel error -f concat -safe 0 -i <list.txt> \
    -c:v libx264 -pix_fmt yuv420p -movflags +faststart -y <movie.mp4>
  ```
  `list.txt` uses the ffmpeg concat-demuxer format (`file '<path>'` per line, single-quoted, no
  other escaping).

---

## REST API

Bearer auth (`AuthenticatedUser`). All paths under `/api/movie`.

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/api/movie/capabilities` | — | `{ llm: LlmCapabilityInfo[], video: LlmCapabilityInfo[] }` |
| POST | `/api/movie/jobs` | `StartJobRequest` (below) | 201, `{ job_id, status: "submitted" }` |
| GET | `/api/movie/jobs` | — | `MovieJobView[]` — last 50 jobs |
| GET | `/api/movie/jobs/{id}` | — | `MovieJobView` |
| POST | `/api/movie/jobs/{id}/poll` | — | `MovieJobView` — reconciles then returns |
| POST | `/api/movie/jobs/{id}/approve` | `{ outline?: string[] }` | `MovieJobView` |
| POST | `/api/movie/jobs/{id}/stop` | — | `MovieJobView` |
| POST | `/api/movie/jobs/{id}/resume` | — | `MovieJobView` |
| POST | `/api/movie/jobs/{id}/retry` | — | `MovieJobView` |
| POST | `/api/movie/jobs/{id}/cancel` | — | `{ job_id, status, message }` |
| DELETE | `/api/movie/jobs/{id}` | — | 204 — also deletes the assembled `image_files` row + blobs if present |

### `StartJobRequest` (JSON body)

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `idea` | string | — | required, non-empty |
| `width` | number | — | required, > 0 |
| `height` | number | — | required, > 0 |
| `scene_count` | number | — | clamped to `[1, 50]` |
| `scene_length` | number | — | clamped to `[1, 300]`; frames per scene clip |
| `long_shot` | boolean | `true` | |
| `auto_approve` | boolean | `true` | |
| `expand_prompt` | boolean | `true` | `false` skips the director LLM call entirely |
| `director_model` | string | — | required; normalized to `llm.<base>` |
| `scene_model` | string | — | required; normalized to `llm.<base>` |
| `video_capability` | string | — | required; normalized to `imggen.<base>` |
| `director_system` | string? | built-in default | see `DEFAULT_DIRECTOR_SYSTEM` in `services/movie.rs` |
| `scene_system` | string? | built-in default | see `DEFAULT_SCENE_SYSTEM` in `services/movie.rs` |
| `initial_image_id` | string? | none | OAI image id (snowflake, as string); must already belong to the user |

Server-side, submitting a job also records `idea`, `director_system`, and `scene_system` into
the prompt-library recent-use buckets `movie-idea`, `movie-director-system`,
`movie-scene-system` (`db::prompts::record_use`).

---

## WebSocket protocol

**Endpoint:** `GET /api/ws/movie` — handler `oai/backend/src/ws/movie.rs` (transport only;
logic in `services/movie.rs`). Auth: `Authorization: Bearer` or `?token=`. JSON, `snake_case`
fields. Ping every 30s; 120s idle read timeout; invalid JSON is silently ignored.

Only one `watch_job` subscription is live per connection — sending a new `watch_job` aborts and
replaces any previous watch task on that socket (`MovieConnectionScope::set_watch`).

### Client → server (`MovieClientCommand`)

| `type` | Fields | Effect |
|--------|--------|--------|
| `list_capabilities` | `req_id` | Emits one `movie_capabilities` reply |
| `watch_job` | `req_id`, `job_id` | Spawns a loop: reconcile (unless terminal/awaitingApproval/paused) → emit `movie:update` → sleep 1s → repeat until the job is terminal. Replaces any previous watch on this connection. |
| `ping` | — | Replies `pong` |

### Server → client (`ServerEvent`, movie-relevant variants)

| `type` | Fields | When |
|--------|--------|------|
| `hello` | `user_id` | Immediately after connect |
| `pong` | — | Reply to `ping` |
| `movie_capabilities` | `req_id`, `llm[]`, `video[]` | Reply to `list_capabilities` (note: no explicit `#[serde(rename)]` on this variant — it serializes under the default `rename_all = "snake_case"` derived from the Rust variant name `MovieCapabilities`) |
| `movie:update` | `req_id`, `job: MovieJobView`, `terminal: bool` | Once per watch-loop iteration for an active `watch_job` subscription |
| `error` | `req_id?`, `message` | Bad job id, job not found, or any reconcile error |

Unlike chat's single-list `capabilities` event, `movie_capabilities` carries two separate lists
(`llm` for director/scene models, `video` for the imggen video capability) since job creation
needs both.

---

## `MovieJobView` shape

```typescript
interface MovieJobView {
  job_id: string                // snowflake, as string
  status: string                // running | awaitingApproval | paused | completed | failed | canceled
  phase: string                 // director | scene_prompt | video | assemble | done
  idea: string                  // user's original idea text
  width: number
  height: number
  scene_count: number
  scene_length: number          // frames per scene clip
  long_shot: boolean
  auto_approve: boolean
  expand_prompt: boolean        // false = skip director LLM, derive outline from idea directly
  director_model: string        // normalized llm.<base>
  scene_model: string           // normalized llm.<base>
  video_capability: string      // normalized imggen.<base>
  director_system: string       // resolved system prompt (default filled in if not supplied)
  scene_system: string          // resolved system prompt (default filled in if not supplied)
  initial_image_id: string | null   // scene 0 seed image, if supplied at submit time
  outline: string[]             // one line per scene, length == scene_count once set
  scenes: SceneView[]
  current_scene: number         // index into `scenes` currently being worked
  active_log: string | null     // streaming log text from the in-flight offload task, if any
  stage: string | null          // in-flight task's reported stage, if any
  error: string | null          // set when status == "failed"
  movie_file_id: string | null  // set when status == "completed"; id into image_files
  created_at: string            // RFC 3339
  updated_at: string            // RFC 3339
}
```

## `SceneView` shape

```typescript
interface SceneView {
  index: number                    // 0-based
  outline: string                  // this scene's outline line
  prompt: string | null            // scene-director's video-generation prompt, once written
  workflow: string                 // "" until rendering starts, then "txt2video" | "img2video"
  input_image_id: string | null    // frame fed into the imggen video job, if any
  imggen_job_id: string | null     // id into image_generation_jobs (the nested imggen pipeline job)
  video_file_id: string | null     // id into image_files once the clip is rendered
  last_frame_image_id: string | null  // ffmpeg-extracted last frame, long-shot mode only
  status: string                   // pending | prompting | rendering | completed | failed
  error: string | null
  submitted_at: string | null      // RFC 3339; when this scene's current offload task was submitted (queue-wait anchor)
  started_at: string | null        // RFC 3339; when this scene's current offload task began executing on an agent
  typical_runtime_seconds: number | null  // execution-time estimate for the current task, from OffloadMQ
  execution_seconds: number | null // time actually spent executing; set once this scene's render completes
}
```

---

## Storage

- **Scene clips** are not special-cased: each scene's render is a full, ordinary
  `image_generation_jobs` row (via `image_jobs::start_job`/`poll_job`) with its own
  `image_files` rows, so every scene clip shows up independently in **My Files** and follows
  the normal imggen storage path (`users/{uid}/videos/output/{imggen_job_id}/{file_id}.mp4`,
  see `services/image_paths.rs::video_output_path`).
- **The assembled movie** is its own standalone `image_files` row — `source: "movie"`,
  `job_id: null` (it has no `image_generation_jobs` parent) — stored at
  `users/{user_id}/videos/movies/{job_id}/{file_id}.mp4`
  (`services/image_paths.rs::movie_output_path`), with a JPEG thumbnail at the usual
  `users/{user_id}/images/thumbnails/{file_id}.jpg` path (`thumbnail_from_video`).
- **Long-shot last frames** are stored as ordinary input `image_files` rows (`source: "upload"`,
  via `image_jobs::upload_input_image`) at `users/{user_id}/images/input/{image_id}.jpg`, same
  as any user-uploaded image.
- Deleting a movie job (`DELETE /api/movie/jobs/{id}`) removes only the assembled movie's file
  + thumbnail + `image_files` row (and recalculates the user's storage total) — the per-scene
  clips and any long-shot frame images are left alone, since they belong to their own imggen
  job rows.
