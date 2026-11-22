# VR Worlds

VR Worlds at `/app/worlds` turns a generated, library, or uploaded image into a Gaussian splat
with an agent `world.*` capability. Open 3D downloads the scene on demand;
Open in headset creates a signed link to `/worlds/view/{id}` without login.

**Generate picture** opens the OAI txt2img prompt and model picker with 2:3 sizes
(1024×1536 and 1280×1920). It uses the same saved and starred prompts, prompt
substitutions, and reverse substitutions as Image Generation. The image job appears
in Image Generation history and Progress. Choose **Use picture** to place the result
in the world form, then select **Build world**. For a 360° world, supply a 2:1
equirectangular panorama for the Lotus generator.

**Upscale** in the picture dialog is off by default. Enable it to pick an Image
Tools upscaler and a multiplier of ×1.5, ×2, or ×3. The image job runs both steps
in the background, and the preview and **Use picture** use the upscaled output.

## Generators

OAI lists every online `world.*` capability; the agent ships two. Both write the
same output contract (below), so OAI treats them alike.

| Capability | Generator | Best for | Needs on the agent |
|---|---|---|---|
| `world.splat[ply;preview;pano]` | `lotus-ldi-v1`: Lotus depth → one disc per pixel + stretched background layer | 2:1 panoramas (360°), fast previews | ComfyUI + an img-utils `depth` workflow |
| `world.sharp[ply;preview;metric]` | `apple-sharp`: Apple SHARP predicts ~1.2 M learned Gaussians at metric scale in one pass | Perspective pictures you lean into — leans and short steps stay solid | The SHARP runtime (`omq sharp install`) |

SHARP only covers what the picture shows (turning past the frame edge shows
nothing) and rejects `mode=pano`. Lotus covers 360° panoramas but tears at depth
edges when leaning. See [VR-WORLD.md](../VR-WORLD.md) and
`examples/vr-world-poc/` for the comparison that led to SHARP.

## Agent and input

**world.splat.** Install an img-utils workflow pack containing `depth.json` and
`depth.params.json` in the agent workflows directory and run ComfyUI. Discovery
advertises the capability only while both are available.

**world.sharp.** Nothing is installed with the agent. `omq sharp install` (or the
agent GUI's **3D Worlds** page) builds a private uv venv with CUDA torch from the
vendored `agent_v2/third_party/ml-sharp` submodule and downloads the 2.8 GB
research-only checkpoint. Discovery advertises the capability once the venv's
`sharp` command exists and the model has its exact published size. See
[agent capabilities](agent-capabilities.md#worldsharp--apple-sharp-splats) for
install, locations, doctor and uninstall.

The task payload requires `input_image`, a filename in the input bucket. Options:

| Key | Default | Range | Used by |
|---|---|---|---|
| `mode` | `auto` | auto / perspective / pano (auto picks pano at aspect 1.9–2.1) | splat; sharp rejects `pano` |
| `max_width` | 1024 | 256–2048 | splat (sharp works at 1536² internally) |
| `hfov` | unset | 20–150° (sharp clamps to 120°) | both — unset = splat 70°, sharp EXIF focal or a 30 mm lens |
| `near` / `far` | 1.2 / 50 | 0.1–20 / 1–1000, far ≥ near + 0.5 | splat |
| `fill_lean` | 0.25 | 0–1 m | splat |

OAI rejects invalid parameters and omits `hfov` unless the user picks one; the
agent clamps numeric values and ignores keys its generator does not use.

Output contains `ply` and `preview` bucket references (filename, file_uid,
bucket_uid, bytes, sha256), plus `depth` for world.splat; the resolved mode,
`splat_count` / `splats_fg` / `splats_bg`, `depth_range_m`, `settings` (world.sharp:
`hfov`, `focal_px`, `focal_source`), `timings`, `generator` and source
dimensions/hash. world.splat adds `grid` and `prompt_id`; world.sharp adds
`runtime` (`revision`, `torch`, `device`, `peak_vram_gib`).

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
Jobs stored before `hfov` became optional keep their explicit 70° on retry.

The page is generator-aware: for `world.sharp` it hides Projection, Splat budget
and Lean range and submits `mode=perspective`; the Field of view picker (Auto,
40–90°) applies to both generators.

Public `GET /api/worlds/public/{id}/scene.ply` (or `preview.png`) requires query
`u`, `exp`, `sig`. HMAC binds owner, job and expiry; bad/expired signatures return
403. Deletion invalidates the link. Treat signed links as access credentials.
Scene responses support 206 for single byte ranges and 416 beyond EOF.

## Configuration and limits

`WORLDS_WORKER_TICK_SECS=10`, `WORLDS_WORKER_BATCH_SIZE=20`;
`WORLD_LINK_TTL_HOURS=24` (1–720). Streaming avoids buffering the PLY on playback.
Scene persistence rejects files over 512 MiB; previews are capped at 32 MiB.
OffloadMQ transfer still buffers whole files; two simultaneous OAI downloads are
allowed per process. PLY files currently do not count toward user storage quotas.

world.splat: depth is relative, occluded background is stretched, and panoramas
can have a seam. world.sharp: every scene is 1,179,648 Gaussians / 63 MiB, ~6 s of
inference after a ~7 s model load, 6.9 GiB peak VRAM (the agent asks ComfyUI to
unload its models first). Quest render quality/FPS and turn/lean comfort require
a real headset test. The viewer provides a VR resolution selector and
FPS/load-time readout.

## Verification

Agent: `uv run --with pytest pytest tests/test_world_splat.py tests/test_world_sharp.py -q`;
`uv run omq sharp doctor` checks a real SHARP install.
Backend: `cargo test worlds`, `cargo test range_tests`.
API: `cd oai/itests` then `uv run pytest tests/test_worlds.py` against a running backend;
the GPU lifecycle skips when no world agent is online.
Browser: `cd oai/e2e` then `npx playwright test tests/worlds.spec.ts` with Vite on 5174.
Headset: open a share link over HTTPS, enter VR, test turns and leans, record FPS.

Earlier world.splat validation (2026-11-21): 34 API checks, Range/signature unit
tests and the world/viewer/progress browser checks passed; its live GPU lifecycle
skipped (no agent connected).

Validation on Windows (2026-11-21), world.sharp: 34 agent world tests, `cargo test
worlds` and the 4 worlds Playwright tests passed. A real task through a local
OffloadMQ server and an isolated agent (RTX 5070 Ti) completed in 32 s with
matching download hashes. The full OAI stack, cancellation of a running SHARP
process and Quest playback were not exercised.
