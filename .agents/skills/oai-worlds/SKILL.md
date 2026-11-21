---
name: oai-worlds
description: VR Worlds image-to-splat generation, job lifecycle, signed headset links and Spark WebXR viewer. Use for world_jobs, services/routes/worlds.rs, WorldsPage, WorldViewerPage, components/worlds, api/worlds.ts and agent exec/world.
---

# VR Worlds

Read `docs/oai-worlds.md` for the contract. Stack with agent-v2 for agent edits,
oai-backend/frontend for the matching OAI surface, and oai-itests for API tests.

- `world.splat` is a routed regular executor; installing an img-utils depth workflow
  plus a reachable ComfyUI enables discovery. It uses Lotus/LDI, not WorldGen.
- Reuse the shared offload-job driver, bucket cleanup and deterministic image_paths.
  Completion holds the download semaphore/advisory lock and rechecks persisted output.
- Preserve bucket ownership checks and file UID validation before downloads.
- Scene serving streams OpenDAL bytes with Range support. Public signatures bind
  job, owner and expiry; never require login for `/worlds/view/:jobId`.
- Lazy-load the viewer; keep large PLY downloads behind Open 3D. OpenCV splats use
  quaternion (1,0,0,0), and XR uses the local reference space.
- Validate with agent test_world_splat.py, Rust worlds/range tests, API test_worlds.py
  and Playwright worlds.spec.ts. Real headset performance needs manual verification.
