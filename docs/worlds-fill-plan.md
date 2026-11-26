# VR Worlds: SHARP with generative hole filling (Plan B)

Status: proposal, 2026-11-26. Expands Plan B of the [quality plan](worlds-quality-plan.md#plan-b--sharp-with-generative-hole-filling).
Nothing is implemented yet.

## Why now

The headset test of the experimental [`world.mirror`](oai-worlds.md#worldmirror-experimental)
confirmed the A1 result: WorldMirror 2.0 on a single picture renders nothing where the
picture has no information, and it guesses worse than SHARP. That is by design. Both are
feed-forward *reconstructors*: they predict Gaussians for the pixels they are given and
do not invent anything else. SHARP looks better only because its second Gaussian layer
smears background behind foreground edges.

Content the picture does not show has to come from a generative model. Plan B adds that
step with components the agent already has: SHARP for geometry and FLUX inpainting in
ComfyUI (the same masked-latent recipe `world.pano360` uses). Plan A2 (WorldStereo 2.0
video views) is the larger bet and stays open. Plan B is cheaper to try and keeps
SHARP's sharp view straight ahead by construction.

## Goal and scope

Widen the usable head-movement range of a `world.sharp` scene:

- lean ±40 cm and step forward 1 m show plausible content instead of holes or smears;
- turning ±35–60° shows a continuation of the scene instead of black;
- the centre view is unchanged (the base SHARP Gaussians are never modified).

Out of scope: walking around the scene, full 360° coverage (A6) and multi-metre steps.
Success is judged with the quality plan's [evaluation protocol](worlds-quality-plan.md#evaluation-protocol).

## Facts this plan relies on

- **SHARP output layout.** 2 layers on a 768×768 grid (1536² input, stride 2) =
  1,179,648 Gaussians. `composer.py` flattens them as `(layer, y, x)`, so Gaussian *i*
  comes from layer `i // 768²` and grid pixel `(i % 768²) // 768, i % 768`. New
  Gaussians can therefore be selected by pixel mask, without a 3D search.
- **Frame.** SHARP writes Gaussians in the OpenCV camera frame of the input picture
  (camera at the origin, +z forward, metric). Every offset view below is a rigid pose
  in that frame.
- **Renderer.** The SHARP venv already depends on `gsplat==1.5.3`, and
  `sharp.utils.gsplat.GSplatRenderer` returns color, depth and alpha. SHARP's own CLI
  renders only on CUDA. It has not yet been run on the Windows agent. The RTX 5070 Ti is
  Blackwell (sm_120), which probably means a JIT compile rather than a prebuilt wheel.
- **Inpainting.** FLUX.1 Fill [dev] is gated and not available. The working recipe on
  this machine is FLUX.1 Krea dev fp8 with masked-latent inpainting, DifferentialDiffusion
  and denoise 1.0, from `world.pano360`
  ([`pano360.py`](../agent_v2/agent/src/offloadmq_agent/exec/world/pano360.py): `outpaint_graph`,
  `_inpaint`, `feather`, `paste_alpha`, `pull_push_fill`). Denoise below 1.0 added large
  framing objects in the pano360 PoC; that lesson carries over.
- **VRAM.** SHARP peaks at 6.9 GiB and FLUX fp8 needs ~12 GB, so they cannot share the
  16 GB GPU. They alternate: `world.sharp` already asks ComfyUI to unload (`/free`)
  before running SHARP, and the SHARP subprocess exits before ComfyUI loads FLUX.

## Pipeline

```
picture ──SHARP──▶ base scene S₀ (metric, OpenCV frame)
for each pose Pₖ in the preset (in order):
    render Sₖ₋₁ from Pₖ          → color, depth, alpha, front-layer alpha
    hole mask Mₖ                 → disoccluded ∪ uncovered, dilated
    FLUX inpaint color in Mₖ     → filled view Iₖ (known pixels pasted back)
    SHARP on Iₖ (same focal)     → Gaussians Gₖ in Pₖ's frame
    fit scale sₖ on known pixels → Gₖ scaled, transformed to the base frame
    keep Gₖ ∩ Mₖ that are hidden from the origin
    Sₖ = Sₖ₋₁ ∪ kept Gaussians
decimate S_N to the splat budget → scene.ply
```

Views are filled **one after another**: view *k* is rendered from the scene that already
contains views 1…*k*−1, so later fills see earlier ones and stay consistent with them.
Generating all views from S₀ independently is the main failure mode to avoid (two leans
inventing two different walls behind the same pillar).

### Hole mask: smears count as holes

Low accumulated alpha only catches black holes (frame edges, turns). The worst defect
when leaning is SHARP's second layer smearing background behind foreground edges. Those
pixels are opaque, so an alpha test misses them. The mask is therefore:

- **disoccluded**: render only the *front* layer of S₀. Pixels where it has low alpha
  show surface the picture never saw, even where the back layer covers them with a smear;
- **uncovered**: the full scene's alpha < 0.5 (outside the original frustum);
- union, dilated by ~8 px at 1536² so the fill overlaps the known surface it continues.

Which of SHARP's two layers is the front surface must be checked in B0 by rendering
each layer alone. Gaussians added by earlier fill views count as front layer.

### Selecting and merging new Gaussians

1. Run SHARP on Iₖ with the same horizontal FOV as the base (`--hfov`, so focal lengths
   match).
2. **Scale.** SHARP is metric, but its scale drifts between pictures. Fit one factor sₖ
   as the median of `rendered_depth / new_front_depth` over pixels outside Mₖ where the
   rendered alpha is > 0.95 (robust, with outliers trimmed). Scale Gₖ about Pₖ's camera
   centre, then transform it to the base frame.
3. **Keep** a new Gaussian only if both hold:
   - its source grid pixel is inside Mₖ (pixel-aligned selection, both layers);
   - from the origin it is outside the original frustum or behind S₀'s rendered depth
     there (with a small margin). This keeps the centre view unchanged.
4. **Seams.** Gaussians in the outer dilation ring get their opacity ramped down
   linearly, so the overlap with the known surface does not double-draw.

### Pose presets

| Preset | Poses (in order) | Covers |
|---|---|---|
| `lean` | lean L 30 cm, lean R 30 cm, lean up 15 cm | leaning around foreground edges |
| `room` (default) | `lean` + step fwd 60 cm, yaw L 30°, yaw R 30° | the quality plan's protocol poses |
| `wide` | `room` + yaw L 60°, yaw R 60°, strafe ±1 m | turning further, at a higher risk of drift |

Yaw views reuse the base FOV. A yaw of 30° keeps about half the frame known, which is
what makes the scale fit and the inpaint context reliable. 60° is only reached through
the 30° view that comes before it.

### Prompt

Use the same default as `world.pano360`: the client's `prompt`, else (in OAI) the
generation prompt of the source image job, else an empty prompt. Inpainting relies
mostly on the visible context, so an empty prompt is acceptable.

## Phases

Each phase ends with a capture sheet in `examples/vr-world-poc/runs/` and a
go / no-go note in this file.

### B0. Renderer and masks (no generation)

1. Make `GSplatRenderer` run in the SHARP venv on the agent. If gsplat will not build
   (MSVC + CUDA 12.8 with `TORCH_CUDA_ARCH_LIST=12.0`), fall back in this order:
   - WSL2 with the same venv recipe;
   - **Spark in headless Chromium** (what `capture.mjs` already drives): render twice on
     black and on white backgrounds, alpha = 1 − (white − black); depth from a z-buffer
     of the Gaussian means (`pipeline.render_preview`). Good enough for masks and the
     scale fit; slow but runtime is not the constraint.
2. Script `examples/vr-world-poc/sharp_fill_poc.py` (runs with the SHARP venv's python,
   like `pano_sharp_poc.py`): predict S₀, render every `wide` pose, write color / alpha /
   front-layer alpha / mask PNGs and a contact sheet.
3. Measure the mask fraction per pose on the five protocol scenes.

**Go** if the masks line up with the smears and holes seen in the headset (check against
`capture.mjs` renders of the same poses). This phase alone tells us how much each pose
really needs filling.

### B1. One view, end to end

On `torii` and `temple`, pose lean L 30 cm only: inpaint → SHARP → scale → select → merge.
Check:

- the fill continues the visible surface (no frame, no new near objects);
- sₖ is stable (compare against a fit on a different pixel subset);
- the centre view is pixel-identical to S₀ when rendered from the origin;
- the seam is not visible when leaning in the headset.

**No-go** (stop Plan B) if the filled Gaussians float visibly in front of or behind the
surface they continue after the scale fit, because SHARP's geometry on inpainted
content is then not consistent enough to merge.

### B2. Incremental multi-view

Full `room` preset on all five scenes. Compare incremental filling with independent
filling (all views from S₀) on one scene to confirm the consistency gain. Record per
view: mask fraction, sₖ, splats added, inpaint and SHARP time.

### B3. Evaluation

Run the quality plan's protocol for SHARP vs SHARP+fill (`room`, then `wide` if `room`
passes). Acceptance is the quality plan's criteria. Plan B also records:

- useful lean radius and step distance in the headset;
- visible seams and any disagreement between views;
- Quest 3 FPS at the merged splat count, before and after decimation.

### B4. Productize as a `world.sharp` option

Only if B3 passes.

**Agent** (`agent_v2/agent/src/offloadmq_agent/exec/world/`):

- `sharp_fill.py`: the loop above. Rendering, lifting and merging run inside the SHARP
  venv through additional runner scripts next to `RUNNER_SOURCE` (the agent itself never
  imports torch). Inpainting reuses pano360's graph helpers, factored into a shared
  module rather than copied.
- Model picking reuses `pano360_runtime.pick_models` (FLUX UNET / CLIP / VAE, no LoRA).
  Discovery adds a `fill` attribute, `world.sharp[ply;preview;metric;fill]`, only when
  the SHARP runtime is installed *and* ComfyUI offers the FLUX models.
- Progress stages: `predict`, `view 2/6 render`, `view 2/6 inpaint`, `view 2/6 lift`,
  `merge`, and a `typicalRuntimeSeconds` taken from the preset.
- Decimate to `max_splats` (default 2 M) by opacity × projected size, removing fill
  Gaussians before base Gaussians.

**Payload additions** (ignored unless `fill` is set):

| Key | Default | Meaning |
|---|---|---|
| `fill` | `off` | `off`, `lean`, `room`, `wide` |
| `prompt` | source image prompt, else unset | Inpaint caption |
| `seed` | random | Inpaint seed (view *k* uses seed + *k*) |
| `max_splats` | 2 000 000 | Delivery budget, capped by OAI under the 512 MiB scene limit |

**Output additions**: `fill` (preset, per-view mask fraction, scale, splats added),
`timings.fill_*`, and an optional `views` contact-sheet JPEG for debugging (not stored
by OAI).

**OAI**: the Worlds page shows a **Fill hidden areas** select and the existing
**Describe the place** prompt field for `world.sharp` when the agent advertises `fill`.
The MCP `generate_world` tool and `oai world` CLI pass `fill` through. Check that no
OffloadMQ or OAI timeout cuts off a ~10-minute regular task. Update
`docs/oai-worlds.md`, `docs/agent-capabilities.md`, the oai-worlds skill and the tests it
lists (`test_world_sharp.py` gains mask / scale / selection unit tests on a synthetic
two-plane scene).

## Cost estimate

Per view: render ~2 s, FLUX inpaint ~30–40 s (one pass at 1536², the outpaint pass in
pano360 is ~40 s), SHARP ~7 s load + ~6 s predict, plus a ComfyUI model reload each time
the GPU alternates. `room` (6 views) ≈ 5–7 minutes and `wide` (10 views) ≈ 10–12 minutes.
Both are within the quality plan's budget. If model swapping dominates, keep the SHARP
model on the CPU between views instead of restarting the subprocess.

Splats: each view adds up to 2 × 768² × mask fraction. At a 10–25% average mask, `room`
adds ~0.6–1.8 M, so the merged scene may exceed the 2 M budget before decimation.

## Risks

- **gsplat on Windows/Blackwell.** Unknown until B0. The Spark fallback keeps the plan
  alive, but it is slower and only approximates depth.
- **Inpaint drift.** FLUX may continue a surface with the wrong material or perspective,
  especially on yaw views where the mask is a large band. Incremental filling and the
  dilation overlap reduce this but do not prevent it.
- **SHARP on synthetic views.** Inpainted regions are sharp 2D images without real
  parallax cues. SHARP may place them flat or at the wrong depth, which B1 tests directly.
- **Thin structures.** Foliage gives fragmented masks that are hard to inpaint
  coherently. Expect the foliage scene to be the last to pass, as in A1.
- **Licences.** SHARP's checkpoint is research-only, so a filled world inherits that.
  FLUX.1 Krea dev is under the FLUX.1 [dev] non-commercial licence. Neither changes
  what `world.sharp` and `world.pano360` already depend on.
