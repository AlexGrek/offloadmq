---
name: oai-generator-improver
description: >-
  OAI Generator Improver at /app/generator-improver — vision JSON quality scoring
  and img2img improvements until expected quality or max steps. Use for its page,
  discriminator branches in image_cycles, JSON vision format, and tests.
---

# Generator Improver

Read `oai-image-cycles` (shared engine), then `oai-img` and matching
`oai-backend` / `oai-frontend` skills. Public contract: `docs/oai-generator-improver.md`.

- Separate app route `/app/generator-improver`; REST prefix
  `/api/generator-improver/jobs`. The router injects `AppKind`; table column `app`
  separates history/access from Image Cycles, including same-user access.
- Images are assessed FIRST; JSON schema is supplied in vision `payload.format`:
  integer `quality` 0–100 and string `improve_prompt`, both required, no extra keys.
  Strictly validate before generating/terminating; retain the raw result on failure.
- Below expected quality, use `img2img` with the assessed image and exactly its
  `improve_prompt`. Do not silently substitute txt2img for an improvement.
- Text starts require a separate txt2img `bootstrap_model`; bootstrap is cycle 0
  and doesn't consume `max_steps`. A max of N improvements has N+1 assessments,
  including a final check after the last improvement.
- Target reached → completed with remaining steps skipped; step budget exhausted
  → completed with `max_steps_reached`, preserving the last score and all images.
- Params: `expected_quality`, `max_steps`, optional `bootstrap_model`; normalized
  `cycles=max_steps`. State machine stays in `services/image_cycles.rs`.
- Shared form/timeline: `ImageCyclesPage` with `improver`; wrapper:
  `GeneratorImproverPage`. Score, raw JSON, improvement prompt and actual image
  must remain visible; completion must distinguish target from budget.
- Migration `m20261020_000037` adds app discriminator and child `response_format`.
  Format must survive describe retry/resize promotion. Child img2img submissions
  use `preserve_input=true` so delete never removes the borrowed seed upload.
- Shared worker/environment: `IMAGE_CYCLES_WORKER_*`; no additional worker.
- Tests: `image-cycles.spec.ts` covers both apps; live API contract in
  `test_generator_improver.py`; JSON validation/chaining unit tests in the service.
