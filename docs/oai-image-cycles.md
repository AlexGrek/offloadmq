# OAI Image Cycles

Open **Image Cycles** from the OAI dashboard (`/app/image-cycles`). Start with one
uploaded/library image or a text prompt, select a vision model and a `txt2img`
model, choose the describe instruction and number of cycles (1–50), and start.

One cycle means **describe the current image → generate a new image from that
exact description**. A text input first generates a starting image (cycle 0),
then performs the requested number of full cycles. For example, two cycles from
an image produce two descriptions and two new images; two cycles from text
produce a starting image followed by two descriptions and two more images.

The describe field uses the same default and saved-prompt bucket
(`describe-image-user`) as Describe Image. The text seed uses `imggen-prompt`.
All cycles use the chosen vision/image models and output dimensions. Vision
inputs are downscaled on the agent with `scale/max[px=1024]`, matching Describe
Image's default. Generation is text-to-image: its prompt is the preceding
vision result, and workflow negative prompts/seeds use their defaults.

The timeline shows every describe instruction, vision result, actual generation
prompt, generated image, status, stage and error. Runs and steps are persisted;
leaving the page does not stop the run. A `?job=<id>` URL restores its detail.
Stopping a run cancels its active child and prevents further submissions. Run
again creates a new run with the original settings. Deleting a terminal run
also deletes its child jobs/generated files, preserving the original seed image.

## Authenticated API

All IDs are strings. All endpoints require the owning user's Bearer token.
Unknown/foreign jobs return 404. Invalid input returns 400.

| Method | Endpoint | Result |
|---|---|---|
| POST | `/api/image-cycles/jobs` | 201 `{job_id, status: "submitted"}`; worker starts it |
| GET | `/api/image-cycles/jobs` | Latest 100 owned runs |
| GET | `/api/image-cycles/jobs/{id}` | Persisted run and all steps |
| POST | `/api/image-cycles/jobs/{id}/poll` | Advance from persisted child results and return run |
| POST | `/api/image-cycles/jobs/{id}/cancel` | Request active-child cancellation; return run |
| POST | `/api/image-cycles/jobs/{id}/retry` | 201, new run from the original settings (terminal runs only) |
| DELETE | `/api/image-cycles/jobs/{id}` | 204; terminal runs only, includes generated outputs |

Reuse `/api/images/upload` for the seed image, `/api/describe/capabilities` for
vision models, and `/api/images/capabilities` for generation models. Models must
be listed; image models need `txt2img` or legacy empty workflow tags.

```json
{
  "input_image_id": "123456789012345678",
  "initial_prompt": null,
  "describe_prompt": "Describe this image in detail.",
  "vision_model": "llm.qwen3-vl:8b",
  "image_model": "imggen.flux",
  "cycles": 3,
  "width": 1024,
  "height": 1024
}
```

Provide exactly one of `input_image_id` and a nonblank `initial_prompt`.
Dimensions must be integers from 128 to 2048. `cycles` must be from 1 to 50.
The response view contains `job_id`, `status`, `params` (the normalized request),
`steps`, `error`, `created_at`, and `updated_at`. Each step contains `cycle`,
`kind` (`describe`/`generate`), `status`, `prompt`, `input_image_id`,
`output_image_id`, `result`, `child_job_id`, `stage`, and `error`.

## Implementation

- Parent: `image_cycle_jobs` (migration `m20261020_000036`), settings and steps
  stored as JSON text; orchestration in `services/image_cycles.rs`.
- Children: existing image-analysis and image-generation jobs; their workers
  poll OffloadMQ, store outputs and release buckets. The parent reads those
  snapshots, avoiding duplicate child poll/download operations.
- Parent progress: `jobs/image_cycles_worker.rs` uses `worker_runtime`, defaults
  to 3 seconds / 20 jobs, configurable with `IMAGE_CYCLES_WORKER_TICK_SECS` and
  `IMAGE_CYCLES_WORKER_BATCH_SIZE`.
- Advance/cancel/delete take a PostgreSQL transaction advisory lock per run,
  bounded to three concurrent lock holders per process. Durable child IDs are
  reserved before submission. Restarts reuse those IDs; an interrupted child
  submission with a created row and no task ID fails visibly instead of silently
  creating another task. Transient reads are retried on later passes.
- Shared default: `frontend/src/lib/describe.ts`; page/API:
  `ImageCyclesPage.tsx`, `api/imageCycles.ts`.
- Validation: backend state-machine unit tests, live API contract tests in
  `oai/itests/tests/test_image_cycles.py`, browser coverage in
  `oai/e2e/tests/image-cycles.spec.ts`.
