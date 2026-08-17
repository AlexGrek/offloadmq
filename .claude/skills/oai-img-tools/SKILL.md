---
name: oai-img-tools
description: >-
  OAI Image Tools at /app/img-utils — one-shot image transforms (image in, one image out,
  no prompt). Covers the two capability families that share the page/table/endpoints:
  ComfyUI img-utils.* tools (depth map, face swap, SeedVR2 upscale) and the built-in Pillow
  image_resize "Basic resize". Spans all three surfaces: the agent workflow install +
  autowiring, the OAI offload-job backend, and the ImgUtilsPage frontend. Use when working
  on oai/frontend/src/pages/ImgUtilsPage.tsx, components/imgutils/**, api/imgUtils.ts,
  oai/backend/src/{routes,services,db}/img_utils.rs, jobs/img_utils_worker.rs, the agent
  exec/imgutils executor, comfy_autowire img-utils keys, or adding/installing a new img-utils
  workflow. Stack with oai-frontend / oai-backend for shared patterns, agent-v2 for the agent.
---

# OAI Image Tools (`img-utils.*`) — Engineering Context

One-shot image transforms at `/app/img-utils`: **an image in, one image out, no prompt.**
Where image generation (`oai-img` skill) is a bespoke multi-file pipeline, Image Tools is a
plain **offload-job framework** feature — see `.claude/skills/oai-new-feature/SKILL.md` for
that shape (`db/offload_jobs.rs` + `services/offload_job.rs` + `worker_runtime`).

**Wire contracts:** `docs/img-utils-api.md` (ComfyUI tools), `docs/image-resize-api.md` (resize).
**Related skills:** `oai-frontend`, `oai-backend`, `oai-img` (sibling generation feature),
`agent-v2` (the Python agent), `debug-stack` (cross-surface task debugging).

---

## Two capability families, one feature

Both share `ImgUtilsPage`, the `img_utils_jobs` table, and **every** endpoint. `kind`
(serialized to the client) selects the form.

| Family | `kind` | Tools | Needs ComfyUI? | Contract |
|--------|--------|-------|----------------|----------|
| `img-utils.*` | `comfy` | depth (Lotus), face_swap (ReActor), upscale (SeedVR2) | Yes — a workflow must be installed | `docs/img-utils-api.md` |
| `image_resize` | `resize` | **Basic resize** — Pillow only | No — online wherever any agent is | `docs/image-resize-api.md` |

`list_capabilities` fetches **both** in one round trip (`OffloadClient::list_capabilities_raw`
+ `parse_capabilities_with_prefix` for each prefix).

---

## The pack / operation convention (get this right)

This trips people up. For a ComfyUI tool:

```
workflows/img-utils/<pack>/<operation>.json          # graph (ComfyUI API format)
workflows/img-utils/<pack>/<operation>.params.json   # payload field → node input map
```

- **`<pack>` is named after the MODEL** (`image_lotus_depth_v1_1`, `seedvr2_upscale_image`) —
  it is the workflow *directory*, and it is **never** a task type.
- **`<operation>` is the file stem** (`depth`, `face_swap`, `upscale`) — the actual task type,
  advertised in the capability brackets.
- Capability registered: `img-utils.<pack>[<operation>]`, e.g.
  `img-utils.seedvr2_upscale_image[upscale]`.
- A pack usually installs one operation, so the client may omit `workflow`; the agent runs the
  sole operation and errors (asking for `workflow`) only when a pack installs several. The
  directory name is **not** a fallback task type.

`depth`/`face_swap`/`upscale` are also legitimate *imggen* task types (with prompt/resolution).
They mean **img-utils** only when under the `img-utils` namespace — never disambiguate by
task-type name alone. In `comfy_autowire.py`, `_IMG_UTILS_TASK_TYPES` (currently `{depth}`)
holds only the names that are img-utils-*only*; `face_swap`/`upscale` are excluded and rely on
the namespace.

---

## Scalar-knob pattern (how upscale's `scale_multiplier` flows)

Image Tools originally took only images. A tool that needs a scalar knob (SeedVR2's
`scale_multiplier`) rides the **existing generic path** — no backend or agent-injection change:

```
Frontend options: { scale_multiplier: 4 }
  → OAI build_task_payload → payload.secondary_prompts.scale_multiplier   (services/img_utils.rs)
  → agent build_injection_values copies secondary_prompts.* verbatim      (imggen/workflow.py)
  → inject_params writes it to the target in <operation>.params.json
      e.g. "scale_multiplier": [["66:57", "resize_type.multiplier"]]
```

So enabling a new knob is: (1) map it in `params.json` (autowiring can do this), (2) send it in
the frontend `options`. The backend forwards `options` verbatim and persists them for **Retry**.

---

## Agent side

| Concern | Where |
|---------|-------|
| Executor | `agent_v2/agent/src/offloadmq_agent/exec/imgutils/executor.py` — thin wrapper over `run_comfy_image_task` with `namespace="img-utils"`; resolves the sole operation from installed files (`_sole_task_type`) |
| Capability discovery | `capabilities_sync.py` `_discover_namespaced_caps` — operations = `.json` stems; advertises `img-utils.<pack>[ops…]` **only if the dir exists** |
| Autowiring | `core/src/offloadmq_core/comfy_autowire.py` — `_IMG_UTILS_KEYS` (per-operation payload keys), `_guess_img_utils`, `_resolve_scale_multiplier` (`_SCALE_MULTIPLIER_INPUTS`) |
| Param-map editor rows | `core/src/offloadmq_core/comfy_service.py` — `_IMG_UTILS_PARAM_UI_ROWS` (image + scale rows, **no** prompt/width/height under the img-utils namespace) |
| Namespace threading | `ui-server/src/ui_server/api.py` passes `namespace` into `guess_params_ex` / `_param_ui_standard_rows` / `_standard_param_field_keys` |

**Add-workflow UI (`ui-server/frontend/src/pages/ComfyPage.tsx`):** the Task-type dropdown
**auto-fills the namespace** via `NAMESPACE_FOR_TASK` (`depth`/`face_swap`/`upscale` → `img-utils`,
`txt2music` → `txt2music`). This is the fix for the classic bug where a workflow lands in the
flat `imggen.*` space and autowires bogus prompt/width/height fields. The param-map editor
(`ComfyParamMapEditor.tsx`) already threads `selectedWf.namespace` into load/save/autodetect.

Run agent typecheck: `cd agent_v2 && uv run --with mypy mypy agent/src core/src ui-server/src --ignore-missing-imports`.

---

## Backend (`img_utils.rs` trio + generic driver)

| Layer | File |
|-------|------|
| Routes | `backend/src/routes/img_utils.rs` (+ `routes/job_common.rs` for `parse_id`, shared DTOs) |
| Service | `backend/src/services/img_utils.rs` — `ImgUtilsReconciler` (`JobReconciler`), `start_job`, `list_capabilities`, `build_task_payload`, `resolve_sole_workflow` |
| Resize payload rules | `backend/src/services/image_resize.rs` (`ResizeOptions`, unit-tested) |
| DB | `backend/src/db/img_utils.rs`, `db/entities/img_utils_jobs.rs` |
| Worker | `backend/src/jobs/img_utils_worker.rs` — `IMG_UTILS_WORKER_TICK_SECS`, `IMG_UTILS_WORKER_BATCH_SIZE` |
| Generic backbone | `db/offload_jobs.rs`, `services/offload_job.rs`, `jobs/worker_runtime.rs`, `offload/task_status.rs` |

**Endpoints** (auth: Bearer; registered in `app.rs`):

```
GET    /api/img-utils/capabilities          both families in one MQ round trip
POST   /api/img-utils/jobs                   StartJobRequest → { job_id, status: "submitted" }
GET    /api/img-utils/jobs                   last 100, images left null
GET    /api/img-utils/jobs/{id}              + resolved input/source/output image refs
POST   /api/img-utils/jobs/{id}/poll         poll MQ + persist + return
POST   /api/img-utils/jobs/{id}/cancel
POST   /api/img-utils/jobs/{id}/retry        replays stored options
DELETE /api/img-utils/jobs/{id}              removes OUTPUT image only (input is a shared upload)
```

`StartJobRequest`: `capability`, `workflow?`, `input_image_id`, `source_image_id?`,
`options?` (map). **comfy tools:** `options` → `secondary_prompts`. **resize:** `options` are
the flat resize params, validated + normalized on submit.

**Two buckets per job:** input bucket `rm_after_task=true`; output bucket persisted in
`img_utils_jobs.output_bucket_uid` (that column is the job's `bucket_uid()`, which the generic
driver releases via `offload_job::release_bucket` on *every* terminal transition — completed,
failed, canceled, task-missing). The input bucket is OffloadMQ's to reap: on agent resolve, or
otherwise via the server's spent-bucket sweep (`src/storage/bucket_reaper.rs`). Nothing waits
for the 24 h TTL. Bucket files are named `input_<id>.jpg` / `source_<id>.jpg` so the same upload
can fill both slots without colliding on the agent.

**Reuses `image_files`:** inputs from the shared `POST /api/images/upload`; output stored via
`image_jobs::store_offload_output_image` (`direction="output"`), so it is served by
`/api/images/files/{id}`, thumbnailed, quota-counted, and shows in **My Files**.

**`workflow_needs_source_image(workflow)`** (in `services/img_utils.rs`) — keyed on the
*operation* (`face_swap*`), not the pack dir. Gates the second image slot + `needs_source_image`
DTO field.

---

## Frontend (`ImgUtilsPage` + tool model)

| Path | Role |
|------|------|
| `frontend/src/pages/ImgUtilsPage.tsx` | Tool picker, image slot(s), resize / scale controls, 3s auto-poll, job detail, compare mode |
| `frontend/src/api/imgUtils.ts` | `ImgUtilCapability` → `ImgUtilTool` flattening, helpers, resize form model |
| `frontend/src/components/imgutils/ImgUtilsHistorySidebar.tsx` | History list; `IMGUTILS_NEW_PANEL` |
| `frontend/src/components/imgutils/ResizeControls.tsx` | Basic-resize form |

**Tool model** (`imgUtils.ts`): capabilities flatten to **one `ImgUtilTool` per operation** via
`toolsFromCapabilities` (`{ capability, pack, workflow, needsSourceImage, takesScale, kind,
methods }`). `toolKey(tool)` = `${capability}::${workflow}` is the picker's selection key.
Name-based flags mirror the backend, keyed on the operation:
- `takesSourceImage(workflow)` = `/^face[_-]swap/` → second upload slot.
- `takesScaleMultiplier(workflow)` = `/^upscale/` → scale-multiplier control (presets 2/4/6/8 +
  numeric `MIN..MAX_SCALE_MULTIPLIER` 1–8, default `DEFAULT_SCALE_MULTIPLIER` = 4); submit sends
  `options: { scale_multiplier }`.
- `prettyLabel(slug)` renders the operation label (`RESIZE_WORKFLOW` `basic_resize` → "Basic resize").
- `OPERATION_HINTS` in `ImgUtilsPage.tsx` holds the one-line blurbs (keyed on operation).

**Progress:** no Progress-drawer entry and no ToolDebug (no `image_offload_tasks` row). The page
**3 s auto-polls the viewed job** (foreground poll → MQ) and **5 s re-lists** while any row is
non-terminal (plain DB read; the `img_utils` worker is what advances those rows). Jobs finish
whether or not the page is open — the page is a view, not the driver.
`img_utils_jobs.started_at` / `typical_runtime_seconds` (set in `ImgUtilsReconciler::on_poll`)
feed the same `JobProgressBar` image generation uses.

**Lightbox / compare:** same `ImageLightbox` + before/after compare (`imgutils-compare-toggle`,
reset on job switch) as `ImageGenerationPage`. `GET`/`poll` resolve `input_image` / `source_image`
/ `output_image` (`JobImageRef`) so actions (Edit→img2img, Animate→img2video, Use-as-input via
in-page `applyAsInput`) need no extra lookup; the list endpoint leaves them `null`.

**Frontend checks:** `cd oai/frontend && npx tsc --noEmit && npx eslint src/pages/ImgUtilsPage.tsx src/api/imgUtils.ts`.
Note: `eslint .` has a large **pre-existing** project-wide baseline (react-hooks@7 promoted
`set-state-in-effect` to error); keep *your* touched files clean, don't chase the baseline.

---

## Recipe: add a new img-utils tool end-to-end

1. **Agent:** install `workflows/img-utils/<pack>/<operation>.json` (ComfyUI API format). Add a
   reference copy under `offload-agent/workflows/img-utils/<pack>/` too.
2. **params.json:** autowire it — in the agent Comfy page, pick the operation (namespace
   auto-fills to `img-utils`) and Save, or hand-write mapping `input_image` (+ `face_swap` /
   scalar knobs) to node ids. For a new scalar, add its key to `_IMG_UTILS_KEYS` and a resolver
   in `comfy_autowire.py`, and a UI row in `_IMG_UTILS_PARAM_UI_ROWS` (`comfy_service.py`).
3. **Restart/rescan the agent** → it registers `img-utils.<pack>[<operation>]`. **No OAI code
   change** for a plain image-in/image-out tool — OAI lists it automatically.
4. **OAI only if a new UI control is needed:** add a name-based helper in `imgUtils.ts`
   (like `takesScaleMultiplier`) and render the control in `ImgUtilsPage.tsx`, sending it in
   `options`. Add an `OPERATION_HINTS` entry.
5. **Docs:** update `docs/img-utils-api.md` (bundled utilities + any new knob).

---

## Pitfalls

1. **Pack ≠ operation.** The directory names the model; the file names the task type. Autowiring/
   OAI resolve the operation from installed files / capability tags, never the directory name.
2. **Namespace matters.** A workflow saved without the `img-utils` namespace registers as flat
   `imggen.*` and autowires prompt/width/height — the "what prompt for an upscaler?!" bug. The
   Add-workflow dropdown auto-fills it; the param editor threads `selectedWf.namespace`.
3. **Knobs are forwarded verbatim** as `secondary_prompts` for comfy tools; the backend does not
   validate them (resize is the exception — `ResizeOptions` is validated + normalized).
4. **No Progress drawer / no ToolDebug** for img-utils jobs — the page's polls plus the
   background worker are the whole story.
   **Worker pickup statuses:** a poll mirrors the upstream status into the row verbatim, so
   in-flight rows sit at `queued`/`assigned`/`starting` as often as `running`. Any query that
   selects jobs for a worker must use `task_status::WORKER_PICKUP_STATUSES` — a hand-written
   subset orphans those rows, and they then only finish while their page is open.
5. **Output-only delete** — the input image is a shared user upload; `delete_job` leaves it.
   (Bucket cleanup is unrelated and automatic — see "Two buckets per job".)
6. **Resize dimensions cap at 1920** (`MAX_IMAGE_EDGE`) — OAI downscales every stored image to
   that, so a larger request could never be delivered; `method` is checked against the agent's
   advertised filters.
7. **No dedicated itest file** — `oai/itests` has none for img-utils yet; verify with the
   agent autowiring unit check + a manual end-to-end run.
```
