---
name: oai-image-cycles
description: >-
  OAI Image Cycles at /app/image-cycles — persistent image/text seed → n
  describe/generate cycles, including all intermediate prompts and images.
  Use for image_cycles backend modules, ImageCyclesPage, or api/imageCycles.ts.
---

# OAI Image Cycles

Read `oai-backend` / `oai-frontend` for parent patterns and `oai-img` before
changing child image/describe services. API and semantics: `docs/oai-image-cycles.md`.

- One cycle is describe current image → txt2img from the exact vision result.
  Text seeds have an extra txt2img bootstrap (cycle 0), followed by n full cycles.
- The describe prompt is the same `DEFAULT_DESCRIBE_PROMPT` and
  `DESCRIBE_PROMPT_BUCKET` from `frontend/src/lib/describe.ts` as Describe Image.
  Do not fork the default or create a separate saved-prompt bucket.
- `image_cycle_jobs` stores parent status, `params_json`, `steps_json`, error and
  timestamps. Migration `m20261020_000036_create_image_cycle_jobs`.
- `services/image_cycles.rs` creates existing image-analysis / image-generation
  child jobs. They own task polling, buckets, file persistence and quotas.
  The parent only reads child snapshots; do not add a competing downloader.
- A PostgreSQL advisory lock serializes advance, cancel and delete across pods.
  Parent writes use the pool outside the advisory transaction so the reserved
  child ID survives a crash before submission. Child services expose
  `start_job_with_id` for this. Never submit before persisting the child link.
- An interrupted child with no offload task fails visibly. Do not blindly
  resubmit a created child: remote submission may already have succeeded.
- `cancelRequested` prevents all later steps; its worker retries active-child
  cancellation. Terminal-only delete removes child jobs and generated outputs,
  preserving the original seed image. Retry starts a new run.
- `jobs/image_cycles_worker.rs` uses `worker_runtime` (3s / 20 defaults), env:
  `IMAGE_CYCLES_WORKER_TICK_SECS`, `IMAGE_CYCLES_WORKER_BATCH_SIZE`.
- Page: `pages/ImageCyclesPage.tsx`; API: `api/imageCycles.ts`; authenticated
  `/api/image-cycles/jobs` CRUD + poll/cancel/retry. Detail URL uses `?job=<id>`.
  Timeline must keep all prompts, descriptions and generated images visible.
- Both apps use the shared `ImageLightbox` for seed previews and step outputs.
  Run slides include the seed and generated images in order; the prompt and
  standard actions follow the selected image. Do not replace previews with
  new-tab links.
- History rows show the input image thumbnail, falling back to the first
  generated output (including text bootstrap); never pick the latest output.
- Compare uses the img2img two-pane layout: input (or first generated image for
  text seeds) versus the latest available output. Show the toggle only for two
  distinct images, keep it live during polling, reset on run switches, and keep
  the timeline visible. Both panes open the shared run lightbox.
- The shared lightbox's Etc menu sends the current image to either new-run form
  through `ImageCycleRouteState.cycleImage`. Handle same-app navigation as well
  as cross-app navigation; sending an image must not submit a run automatically.
- Tests: `oai/e2e/tests/image-cycles.spec.ts`,
  `oai/itests/tests/test_image_cycles.py`, service unit tests.

## Generator Improver shares this engine

Read `oai-generator-improver` for its discriminator branches: vision JSON score /
`improve_prompt`, img2img, expected quality and max steps. Migration 000037 adds
`image_cycle_jobs.app` and `image_analysis_jobs.response_format`. The router binds
the app name; list/detail/mutations enforce separate histories. `ImageCyclesPage`
is shared with its dedicated wrapper. Regular Image Cycles always clears improver
options on submit and keeps its txt2img behavior.


## Run controls

- Persisted `paused` parents are excluded from background pickup and stale expiry.
  Foreground poll may reconcile an existing child but must not submit while paused.
- `/pause`, `/resume`, `/restart`, and `PATCH /models` share the advisory lock with
  poll/cancel. Restart cancels remaining work and creates a NEW run from the seed
  using the latest models, preserving the old run and outputs.
- Model updates validate workflow-compatible listed models and affect subsequent
  submissions. Step `model` snapshots preserve actual historical models; backfill
  legacy snapshots from child records before changing parameter defaults.
- DB `save` persists params/status/steps; `fail_stale` deliberately excludes paused.
- Detail editor: `components/imagecycles/RunModelsEditor.tsx`; drafts remain separate
  from new-run form state and background polling.
