# VR Worlds

VR Worlds at `/app/worlds` turns a library image or upload into a Gaussian splat
with the agent's `world.splat` capability. Open 3D downloads the scene on demand;
Open in headset creates a signed link to `/worlds/view/{id}` without login.

## Agent and input

Install an img-utils workflow pack containing `depth.json` and `depth.params.json`
in the agent workflows directory and run ComfyUI. Capability discovery advertises
`world.splat[ply;preview;pano]` only while both are available. No new model is
installed automatically. The generator is Lotus depth plus layered-depth fill
(`lotus-ldi-v1`), not WorldGen.

The task payload requires `input_image`, a filename in the input bucket. Options:
`mode` = auto/perspective/pano (auto chooses pano at aspect 1.9?2.1), `max_width`
= 1024 (256?2048), `hfov` = 70 (20?150), `near` = 1.2 (0.1?20), `far` = 50
(1?1000, at least near + 0.5), `fill_lean` = 0.25 (0?1 metres).
OAI rejects invalid parameters; the agent clamps numeric values.

Output contains `ply`, `preview`, `depth` bucket references (filename, file_uid,
bucket_uid, bytes, sha256), resolved mode, splat counts, depth_range_m, settings,
timings, generator, source dimensions/hash and prompt_id.

## OAI API

All `/api/worlds` job routes require Bearer JWT (file routes also accept `?token=`):

| Method | Path | Result |
|---|---|---|
| GET | /api/worlds/capabilities | Online capabilities |
| POST / GET | /api/worlds/jobs | Create / list owned jobs |
| GET / DELETE | /api/worlds/jobs/{id} | Detail / delete terminal job and blobs |
| POST | /api/worlds/jobs/{id}/poll | Reconcile result |
| POST | /api/worlds/jobs/{id}/cancel | Cancel |
| POST | /api/worlds/jobs/{id}/retry | Replay failed/canceled job parameters |
| POST | /api/worlds/jobs/{id}/share | viewer_url, ply_url, preview_url, expires_at |
| GET | /api/worlds/jobs/{id}/scene.ply | Streaming scene; supports single byte Range |
| GET | /api/worlds/jobs/{id}/preview.png | Preview |

Create accepts `capability`, string `input_image_id`, and the optional task
parameters above. Upload through the existing `/api/images/upload` endpoint.
Images must belong to the caller. Jobs progress through submitted/pending/running
to completed/failed/canceled. A worker reconciles unattended jobs and releases
output buckets after persistence. Stored results omit temporary bucket refs.
Deleting an input image clears its job reference; retry then requires a new job.

Public `GET /api/worlds/public/{id}/scene.ply` (or `preview.png`) requires query
`u`, `exp`, `sig`. HMAC binds owner, job and expiry; bad/expired signatures return
403. Deletion invalidates the link. Treat signed links as access credentials.
Scene responses support 206 for single byte ranges and 416 beyond EOF.

## Configuration and limits

`WORLDS_WORKER_TICK_SECS=10`, `WORLDS_WORKER_BATCH_SIZE=20`;
`WORLD_LINK_TTL_HOURS=24` (1?720). Streaming avoids buffering the PLY on playback.
Scene persistence rejects files over 512 MiB; previews are capped at 32 MiB.
OffloadMQ transfer still buffers whole files; two simultaneous OAI downloads are
allowed per process. PLY files currently do not count toward user storage quotas.

Depth is relative, occluded background is stretched, and panoramas can have a
seam. Quest render quality/FPS and turn/lean comfort require a real headset test.
The viewer provides a VR resolution selector and FPS/load-time readout.

## Verification

Agent: `uv run --with pytest pytest tests/test_world_splat.py -q`.
Backend: `cargo test worlds`, `cargo test range_tests`.
API: `cd oai/itests` then `uv run pytest tests/test_worlds.py` against a running backend;
the GPU lifecycle skips when world.splat is offline.
Browser: `cd oai/e2e` then `npx playwright test tests/worlds.spec.ts` with Vite on 5174.
Headset: open a share link over HTTPS, enter VR, test turns and leans, record FPS.
