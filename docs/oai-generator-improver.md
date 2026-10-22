# OAI Generator Improver

Open **Generator Improver** from the dashboard (`/app/generator-improver`). Supply
an image (upload, paste/drop, or My Files) or a text prompt. Choose a vision model,
an improvement workflow (**img2img** or **txt2img**) and compatible model, expected
quality (1–100), and maximum improvement steps (1–50). A text start uses a
**txt2img starting-image model** and requires no uploaded image.

The app assesses the current image before improving it. Vision requests carry
an actual JSON schema in `payload.format`, requiring exactly:

```json
{"quality": 95, "improve_prompt": "Fix the hand anatomy and improve the lighting."}
```

`quality` is an integer from 0 to 100, not `"95/100"`. The backend validates the
response before using it. Invalid JSON, missing fields, invalid scores, or blank
improvement instructions below target fail visibly. Raw responses remain visible
in the history, including on failure.

If the score meets the expected quality, the run completes immediately. Otherwise,
**the current image plus `improve_prompt`** go to the selected img2img model by
default. In **Regenerate · txt2img** mode, the assessor instead writes a complete,
standalone prompt for the desired image; only that text goes to the txt2img model,
without an input image. The result is stored and assessed again. Maximum steps
limits **improvement generations**:
N improvements have up to N+1 assessments, including a final assessment after the
last improvement. Text starts first generate a seed with txt2img (cycle 0), which
does not consume an improvement step.

The timeline retains all images, scores, assessment instructions, raw JSON, and
actual generation prompts. A live quality graph plots each assessment on a fixed
0–100 scale, with a dashed target line, the latest score, and the change from the
first score. Long runs scroll within the graph on narrow screens. Completion
distinguishes `target_reached` from
`max_steps_reached` and shows the final quality. The latest image and all previous
outputs are retained even if the target wasn't reached. Runs continue in the
background; `?job=<id>` restores detail. Stop cancels active work and prevents
later steps; Run again starts from the original settings. Delete removes child
jobs/generated outputs while preserving the original seed image.

## Authenticated API

Use the CRUD/poll/cancel/retry contract from [Image Cycles](oai-image-cycles.md),
with prefix `/api/generator-improver/jobs`. Each app has separate history, and
accessing a run through the other app's endpoint returns 404 even for its owner.

```json
{
  "input_image_id": "123456789012345678",
  "initial_prompt": null,
  "describe_prompt": "Critically assess visual quality and propose specific fixes.",
  "vision_model": "llm.qwen3-vl:8b",
  "image_model": "imggen.flux",
  "expected_quality": 95,
  "max_steps": 5,
  "width": 1024,
  "height": 1024
}
```

Text starts set `input_image_id` to null, supply `initial_prompt`, and include
`bootstrap_model` (a listed txt2img capability). Optional `improvement_workflow`
is `img2img` (the default for existing and new runs) or `txt2img`. `image_model`
must support the selected workflow; known legacy models with empty workflow tags
are accepted. In txt2img mode, an omitted `bootstrap_model` defaults to
`image_model` for text starts. Improvement tasks use the explicitly selected
workflow, and bootstrap tasks always use `txt2img`. The workflow remains fixed
for a run, including restarts; live model edits must support that workflow.
Dimensions are integers from 128 to 2048. Model discovery reuses
`/api/describe/capabilities` and `/api/images/capabilities`.

Responses extend the Image Cycles view with `app: "generator-improver"` and
`stop_reason` (`target_reached`, `max_steps_reached`, or null). Normalized
`params.cycles` equals `max_steps`. Assessment steps add `quality` and
`improve_prompt`; unused steps have status `skipped` on early success.

## Engineering notes

Shared engine/router: `services/image_cycles.rs`, `routes/image_cycles.rs`.
Shared table/worker: `image_cycle_jobs`, `image_cycles_worker`. The router injects
the app discriminator; callers cannot choose it in the request body. Migration
`m20261020_000037_image_cycle_apps` adds the discriminator and child
`image_analysis_jobs.response_format`, which survives retries/resize promotion.
The JSON schema goes through `OffloadClient::submit_vision_task_with_format`.

Shared UI: `ImageCyclesPage.tsx` with `improver`; app wrapper:
`GeneratorImproverPage.tsx`. Child img2img jobs borrow inputs with
`preserve_input=true`, so deletion doesn't consume the seed upload.

Worker configuration is shared: `IMAGE_CYCLES_WORKER_TICK_SECS` (3 seconds),
`IMAGE_CYCLES_WORKER_BATCH_SIZE` (20). Child polling/storage/bucket cleanup remain
with the existing describe/image workers. Concurrency/restart behavior follows
Image Cycles. Tests: `image-cycles.spec.ts` (both apps),
`test_generator_improver.py`, and service JSON validation/chaining unit tests.


## Controls and parser recovery

Pause/resume, cancel, restart from the seed, and live model selection are shared
with [Image Cycles run controls](oai-image-cycles.md#run-controls-and-model-changes).
Model changes apply to subsequent submissions; current tasks and past steps
retain their original model names.

Markdown rendering hides code fences. A response beginning with a code fence
can therefore look like valid JSON on screen while the old bare-object parser
fails at line 1 column 1. Parsing now accepts one valid object from Markdown
fences/preamble, a leading BOM, a JSON-encoded string, and closed reasoning blocks
before the answer. Schema/types/score bounds remain strict; multiple valid
assessment objects are rejected as ambiguous. Raw vision response exposes the
exact source, including wrappers.

Retry assessment parsing reuses a completed vision child's saved response,
preserving completed work without another inference. Restart creates a separate
run from the original seed with the latest models.
