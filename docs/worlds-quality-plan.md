# VR Worlds: quality plan

Status: proposal, 2026-11-26. A0 (WorldMirror part) and [A1](#a1-result-2026-11-26) done (and available for headset comparison as the experimental [`world.mirror`](oai-worlds.md#worldmirror-experimental)). Plan B is expanded in [worlds-fill-plan.md](worlds-fill-plan.md); its first phase (B0, masks) is done. Builds on [VR Worlds](oai-worlds.md), [VR-WORLD.md](../VR-WORLD.md)
and the PoC in [`examples/vr-world-poc/`](../examples/vr-world-poc/README.md).

## Goal

Produce worlds that look more real in the headset than `world.sharp`, on the existing
RTX 5070 Ti 16 GB agent. Runtime is not the constraint: several minutes per clip and
up to ~30 minutes per world are acceptable when the result is better.

`world.splat` (Lotus/LDI) and `world.pano360` (WorldGen recipe) are not developed
further. Their output is clearly below SHARP and they are not the baseline.

## Where SHARP falls short

SHARP is a feed-forward *reconstructor*. It predicts ~1.18 M metric Gaussians for the
pixels the picture shows, in ~6 s. Inside the original frame it is crisp, and its paper
reports better nearby-view quality than diffusion methods such as Gen3C. Its limits
are all about content the picture does not show:

- Leaning past a foreground edge exposes stretched or missing background.
- Stepping forward or sideways beyond a few tens of centimetres breaks the scene.
- Turning past the frame edge shows nothing.

Fixing these means *generating* unseen content consistently from several viewpoints.
The methods that do this well use one recipe: a camera-controlled video diffusion model
generates views around the start pose, and a reconstructor turns them into Gaussians.
No published work compares any of them with SHARP directly, so every candidate below
must be judged with the [evaluation protocol](#evaluation-protocol).

## Options reviewed

| Option | Approach | Fit for the 16 GB agent | Decision |
|---|---|---|---|
| **HY-World 2.0** (Tencent, Apr–May 2026) | Panorama (HY-Pano 2.0) → camera trajectories (WorldNav) → **WorldStereo 2.0** keyframe video (Wan-based, ~17B) → **WorldMirror 2.0** (1.2B, feed-forward depth/cameras/3DGS) → optional 3DGS training | Official setup: Linux, ≥4 GPUs. The community ComfyUI pack `ComfyUI_HYWorld2` loads `worldstereo-camera` (10.9 GB transformer) in fp8 with sequential CPU offload, "feasible on 16 GB", and WorldMirror 2.0 in fp8. | **Plan A** |
| SHARP + generative hole filling | Render SHARP from offset poses, inpaint the holes in ComfyUI, run SHARP on the filled views, merge by metric depth | Uses only installed components | **Plan B** |
| FlashWorld (ICLR 2026, Apache-2.0) | Wan 2.2 5B with a 3DGS decoder, single image → Gaussians | 24 GB with offload (20 s); 9 GB with VAE offload (~10 min) | Backup if Plan A cannot run |
| Lyra 2.0 (NVIDIA) | Wan 14B autoregressive exploration → Depth Anything 3 → 3DGS | Tested on H100, Linux only | Rejected: model licence forbids production use |
| World Labs Marble API | Hosted image → ~2 M-splat world, ~$1.26 per world | Hosted | Rejected: discontinued 2027-01-08, credit purchases end 2026-12-08 |
| World Labs Atlas | Hosted multi-step: pose image → generate views → splats (SPZ) | Hosted | Rejected: $5 and 15–21 min per refined scene, SPZ only, vendor just retired its previous API |

In Tencent's single-view reconstruction table, WorldStereo 2.0 scores F1 41.43 (Tanks and
Temples) and 51.27 (MipNeRF360). Lyra scores 32.54 / 36.05 and FlashWorld 22.29 / 42.60.
These are the vendor's own numbers.

## Evaluation protocol

Every experiment uses the same inputs, poses and renderer so results compare directly.

**Test set** (keep the source PNG and its hash in `runs/<name>/`):

1. `torii` shrine, 1080×1920, outdoor, mid-distance subject (existing `torii-sharp` run)
2. `temple` interior, 1536², columns close to the camera
3. `courtyard` seen through an arch (the VR-WORLD.md reference scene)
4. `market` beach seen from a hill (downward camera)
5. A foliage-heavy scene (thin structures, hardest case)

**Poses**: `capture.mjs` defaults (centre, lean L/R 20 cm, step forward 50 cm, step left
1 m, turn left 35°) plus `turn 90`, `lean 40 cm` and `step fwd 1 m`. Use `POC_POSES`.

**Per run, record**: generator and revision, settings, warm runtime per stage, peak VRAM,
splat count, PLY size, and the capture sheet. Then a short headset session over the
signed OAI link: useful lean radius, useful step distance, visible defects, FPS.

**A candidate beats SHARP** when, on at least four of the five scenes:

- the centre view is not visibly softer than SHARP's,
- lean 40 cm and step forward 1 m show plausible content where SHARP shows holes or smears,
- it renders on Quest 3 at ≥ 72 FPS after decimation to the delivery budget (start at 2 M splats).

## Plan A — HY-World 2.0 on the 5070 Ti

### A0. Environment

1. Read the HY-World 2.0 Community License
   ([License.txt](https://github.com/Tencent-Hunyuan/HY-World-2.0/blob/main/License.txt)).
   Confirm territory and use terms before downloading weights. **Done:** it excludes the
   EU, UK and South Korea for the code, weights *and outputs*; elsewhere it is royalty-free
   under an acceptable-use policy, bars using outputs to improve other models, and needs a
   separate licence above 1 M monthly users. The operator confirmed this machine is in the
   licensed territory. Re-check before any deployment or sharing of generated worlds.
2. Choose the runtime:
   - **ComfyUI route**: install `ComfyUI_HYWorld2` (AHEKOT) into the agent's ComfyUI. It is
     the fastest way to a first result and reuses the GPU the agent already shares.
   - **Standalone route**: a private uv venv built from the official repository, like
     `omq sharp install`. More control over trajectories and the trainer; needs the
     FlashAttention and CUDA 12.8 stack on Windows, or WSL2.
   Start with ComfyUI for A1–A2; switch if the nodes cannot express the trajectories.
3. Record model sizes, download time and the resolved package versions.

### A1. WorldMirror 2.0 on the single picture

Run WorldMirror 2.0 alone on each test picture and write `gaussians.ply`. This is a cheap
feed-forward baseline: it shows whether WorldMirror's geometry and Gaussians match SHARP
inside the frame, which decides how the final composition is built (A3).

#### A1 result (2026-11-26)

Run on all five scenes; numbers and method in the
[PoC README](../examples/vr-world-poc/README.md#worldmirror-20-on-a-single-picture--plan-a1-2026-11-26).

- Runtime chosen for A1: a private uv venv with the official code (Windows, no WSL, no
  FlashAttention build). The ComfyUI route is still open for A2's WorldStereo.
- 0.4–0.7 s inference, 7.8–9.3 GiB peak, provided no other model holds the GPU.
- Inside the frame, depth matches SHARP within 1.7–4.6% median (courtyard, temple,
  market) after a global scale; 12% on torii; 34% on the foliage scene.
- As a world on its own it loses to SHARP on all five: one surface layer (black holes on
  every lean), not metric, smeared foreground on the foliage scene.
- Headset check (2026-11-26, `world.mirror`): confirmed. It renders nothing where the
  picture has no information and guesses worse than SHARP. A reconstructor cannot invent
  unseen content; that has to come from A2 (WorldStereo) or Plan B.

What this means for the next steps:

- **A3:** keep SHARP inside the original frustum (option 3, hybrid). WorldMirror's role is
  fusing generated views, which A1 did not test.
- **A2 conditioning:** use SHARP's metric depth for the point cloud, not WorldMirror's.
- **Composition:** turn the sky and edge masks off or tune them; convert opacity to a
  logit; check WorldMirror's fx/fy when mixing its cameras with SHARP's.
- **A5:** the agent must free Ollama as well as ComfyUI memory before a run.

### A2. WorldStereo 2.0 views on fixed trajectories

Skip WorldNav (it needs Qwen3-VL-8B on vLLM plus SAM3). The intended experience is a small
area around an authored viewpoint, so fixed trajectories are enough:

| Trajectory | Motion |
|---|---|
| lean | ±40 cm lateral, eyes at constant height |
| step | 0 → 1 m forward, then back |
| strafe | ±1 m lateral |
| look | yaw ±60° from the start pose |
| orbit | ±20° around the main subject (set from the WorldMirror depth median) |

Condition WorldStereo on the picture plus the A1 point cloud (or SHARP's metric depth if
WorldMirror's is weaker). Keep the default sampling steps first; try the distilled
variants only if runtime exceeds the budget. Record per-clip runtime and peak VRAM with
`nvidia-smi` sampling, and unload other ComfyUI models before each run.

### A3. Composition

Compare three ways of turning the views into one scene:

1. **Feed-forward**: WorldMirror 2.0 on the original picture plus all generated keyframes.
2. **Trained**: the repository's `world_gs_trainer.py` on that output (8000 steps is the
   documented single-GPU setting). Needs gsplat; if it will not build on Windows, run it
   in WSL2.
3. **Hybrid (Plan C)**: option 1 or 2, with every Gaussian inside the original camera
   frustum and depth range replaced by SHARP's prediction, scaled to match by
   overlapping depth.

### A4. Decision

Run the protocol on all five scenes for SHARP, A3.1, A3.2 and A3.3. Continue to A5 only
if one variant meets the acceptance criteria. Otherwise try FlashWorld with VAE offload
before dropping the plan.

### A5. Productize as `world.hyworld`

**Agent** (`agent_v2/agent/src/offloadmq_agent/exec/world/`):

- `hyworld.py` executor and `hyworld_runtime.py` install/doctor, following `sharp*.py`:
  a private venv, `omq hyworld install|status|doctor|uninstall`, and an agent GUI section.
  Discovery advertises `world.hyworld[ply;preview;metric;generative]` only when the
  runtime and every weight file are present.
- Ask ComfyUI to unload its models before the run (as `world.sharp` does), or run inside
  ComfyUI if the node route was kept.
- Report stage progress (`views 3/5`, `compose`, `train 4000/8000`) and
  `typicalRuntimeSeconds`, so OAI's progress bar works on a 10–30 minute task.
- Decimate to `max_splats` (default 2 M) by opacity × screen-space size from the start
  pose before writing the PLY.

**Payload** (in addition to `input_image`, `hfov`):

| Key | Default | Meaning |
|---|---|---|
| `preset` | `room` | Trajectory set: `room` (lean, step, look), `walk` (adds strafe, step 2 m), `object` (orbit) |
| `prompt` | the picture's generation prompt | Caption for the video model |
| `seed` | random | Generation seed |
| `quality` | `trained` | `fast` (feed-forward only) or `trained` (adds 3DGS training) |
| `max_splats` | 2 000 000 | Delivery budget; OAI caps it under the 512 MiB scene limit |

**Output**: the existing contract (`ply`, `preview`, `splat_count`, `settings`,
`timings`, `generator`, `runtime`) plus `trajectories` and `views` (generated keyframe
count). Optionally a `views` contact-sheet JPEG for debugging.

**OAI**: the Worlds page shows Preset, Quality and the prompt field for `world.hyworld`
and hides the Lotus-only controls. Check that no OffloadMQ or OAI timeout cuts off a
30-minute regular task. The MCP `generate_world` tool passes the new keys through.
Update `docs/oai-worlds.md`, `docs/agent-capabilities.md`, the oai-worlds skill and
the tests listed there.

### A6. Optional: 360° coverage

If A5 holds up, add the panorama stage for worlds you can turn all the way round in:
HY-Pano 2.0 through its Qwen-Image-Edit-2509 LoRA (425 M) in ComfyUI, then the same
WorldStereo/WorldMirror pipeline with a `pano` preset. This would replace the
`world.pano360` outpaint and its Lotus depth.

## Plan B — SHARP with generative hole filling

The detailed plan (masks that also catch SHARP's smears, incremental view filling, scale
fit, phases B0–B4) is in [worlds-fill-plan.md](worlds-fill-plan.md).

Runs in parallel with Plan A because it only needs installed components. It widens the
usable lean and step range while keeping SHARP's front view.

1. Predict the base scene with SHARP (metric).
2. Render it with alpha and depth from offset poses: lean ±30 cm, step forward 60 cm,
   yaw ±30°. Needs a real Gaussian rasterizer on the agent; the current preview renderer
   draws points.
3. Build hole masks from low accumulated alpha, dilated by a few pixels.
4. Inpaint each view in ComfyUI (FLUX Fill or Qwen-Image-Edit-2511), prompted with the
   picture's prompt.
5. Run SHARP on each filled view with the known pose and focal length.
6. Fit scale and shift from overlapping depth against the base scene; keep only the new
   Gaussians that land in previously empty space.
7. Merge, decimate to the budget and write the PLY.

Ship as a `world.sharp` option (`fill_views`, default off) rather than a new capability.
Main risks: inconsistency between independently inpainted views, and seams where filled
regions meet. The cube-face PoC showed SHARP views join cleanly when the scale anchor is
good; here the anchor is SHARP itself.

## Risks and open questions

- **WorldStereo on 16 GB is unmeasured.** The 10.9 GB figure and "feasible with offload"
  come from community node documentation, not Tencent. Host RAM matters too: sequential
  offload keeps the weights in system memory.
- **Windows support.** HY-World 2.0 documents Linux only. WSL2 is the fallback.
- **Licences.** HY-World 2.0's community licence excludes the EU, UK and South Korea,
  including outputs (see A0). A `world.hyworld` capability would have to state this and
  stay off by default. SHARP's checkpoint is research-only.
- **Quest budget.** HY-World composition can emit up to 5 M Gaussians by default. SHARP's
  SH0 PLY is ~56 bytes per splat (63 MiB for 1.18 M), so 2 M ≈ 107 MiB. Measure FPS
  before raising the default.
- **No independent SHARP comparison exists.** Plan A may win only outside the frame,
  which is why Plan C (SHARP in front) is part of A3.

## Sources

- HY-World 2.0: [GitHub](https://github.com/Tencent-Hunyuan/HY-World-2.0), [model card](https://huggingface.co/tencent/HY-World-2.0), [report](https://arxiv.org/abs/2604.14268)
- ComfyUI nodes: [ComfyUI_HYWorld2](https://comfy.icu/extension/AHEKOT__ComfyUI_HYWorld2), [Load WorldStereo Model](https://comfy.icu/node/VNCCS_LoadWorldStereoModel), [WorldMirror V2](https://comfy.icu/node/VNCCS_WorldMirrorV2_3D)
- FlashWorld: [GitHub](https://github.com/imlixinyang/FlashWorld), [paper](https://arxiv.org/abs/2510.13678)
- Lyra: [GitHub](https://github.com/nv-tlabs/lyra), [Lyra-2.0 model card](https://huggingface.co/nvidia/Lyra-2.0)
- World Labs: [discontinuation notice](https://docs.worldlabs.ai/discontinuation.md), [Marble API pricing](https://docs.worldlabs.ai/api/pricing), [Atlas docs](https://docs.atlas.worldlabs.ai/llms.txt)
- SHARP: [paper](https://arxiv.org/html/2512.10685v2), [code](https://github.com/apple/ml-sharp)
