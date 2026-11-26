---
name: oai-worlds
description: VR Worlds image-to-splat generation, job lifecycle, signed headset links and Spark WebXR viewer. Use for world_jobs, services/routes/worlds.rs, WorldsPage, WorldViewerPage, components/worlds, api/worlds.ts and agent exec/world.
---

# VR Worlds

Read `docs/oai-worlds.md` for the contract. Stack with agent-v2 for agent edits,
oai-backend/frontend for the matching OAI surface, and oai-itests for API tests.

- `world.splat` is a routed regular executor; installing an img-utils depth workflow
  plus a reachable ComfyUI enables discovery. It uses Lotus/LDI, not WorldGen.
- `world.pano360` (agent `exec/world/pano360*.py`, `omq pano360`) is the WorldGen recipe:
  FLUX.1-dev + WorldGen LoRA outpaints a perspective picture to 360°, then Lotus/LDI.
  OAI passes `prompt`/`pitch`/`seed` (pano360 only), defaults the prompt to the source
  image job's prompt, and rejects `mode=pano` for it as for `world.sharp`. Keep
  `denoise` at 1.0 and the paste-back ramp narrow — both prevent a FLUX patch-grid pattern.
- `world.mirror` (agent `exec/world/mirror*.py`, `omq mirror`) is experimental Tencent
  WorldMirror 2.0. Its licence excludes the EU, UK and South Korea (outputs too): keep it
  off until accepted, never vendor Tencent code or weights, never auto-pick it in OAI,
  list it last. It takes only `cleanup`; scale comes from SHARP when installed.
- Reuse the shared offload-job driver, bucket cleanup and deterministic image_paths.
  Completion holds the download semaphore/advisory lock and rechecks persisted output.
- Preserve bucket ownership checks and file UID validation before downloads.
- Scene serving streams OpenDAL bytes with Range support. Public signatures bind
  job, owner and expiry; never require login for `/worlds/view/:jobId`.
- Lazy-load the viewer; keep large PLY downloads behind Open 3D. OpenCV splats use
  quaternion (1,0,0,0), and XR uses the local reference space.
- Validate with agent test_world_splat.py, test_world_pano360.py, test_world_mirror.py, Rust worlds/range tests, API test_worlds.py
  and Playwright worlds.spec.ts. Real headset performance needs manual verification.
