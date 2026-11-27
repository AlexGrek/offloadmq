# VR world POC

A local proof of concept for [VR-WORLD.md](../../VR-WORLD.md): art → depth → Gaussian splat
PLY → WebXR viewer on Quest 3.

**It does not use WorldGen.** WorldGen needs gated FLUX.1 Fill [dev] (Hugging Face login), a
Linux-only Nunchaku wheel, and tens of GB of model downloads. This POC runs the same three
stages on the ComfyUI instance the OffloadMQ agent already drives:

| Stage | WorldGen | This POC |
|---|---|---|
| Art | input image / FLUX | z-image turbo (`--prompt`) or any image (`--image`) |
| Panorama extension | FLUX Fill outpainting + LoRA | none; `--mode pano` asks z-image for an equirectangular image directly |
| Depth | DA-2 | Lotus-D using the repo's `img-utils/depth` workflow, the same one behind `img-utils.depth` |
| Occluded surfaces | generative inpainting | "layered depth image lite": background is stretched behind every depth edge, sized for a `--fill-lean` head movement |
| Splat | depth → 3DGS | one camera-facing disc per pixel, standard 3DGS PLY (OpenCV frame) |
| Viewer | Viser | Spark 2.4 + WebXR (`index.html`); the PLY also works in SuperSplat and StrikeLines |

## Run

ComfyUI must be reachable (default `http://127.0.0.1:6966`, override with `--comfy`), with
`z_image_turbo_bf16`, `qwen_3_4b`, `ae`, `lotus-depth-d-v1-1` and `vae-ft-mse-840000-ema-pruned`.

```bash
cd examples/vr-world-poc
uv run pipeline.py --name courtyard-01 --seed 4242 --prompt "Oil painting of a stone courtyard seen through a large arch ..."
uv run pipeline.py --name pano-01 --mode pano --max-width 1024 --prompt "..."
uv run pipeline.py --name mine --image path/to/art.png
uv run pipeline.py --name courtyard-01 --reuse --far 30     # re-splat cached art/depth with new settings
uv run serve.py                                             # http://localhost:8443
```

Each run writes `runs/<name>/`: `source.png`, `depth.png`, `scene.ply`, `run.json` (settings,
hash, timings, splat count), and `previews.png`. The preview is a CPU re-render from the
centre, 10/20 cm leans and a 30 cm step, plus 90/180/270° turns in pano mode. Magenta = a
disoccluded hole.

Useful knobs: `--near/--far` (metres the depth map spans), `--hfov` (assumed lens),
`--fill-lean` (head movement the hidden background must cover), `--max-width` (splat budget:
1 splat per pixel).

## Getting it into the Quest 3

- **Link / Air Link (simplest on this PC):** start Quest Link, open `http://localhost:8443` in
  Edge or Chrome on the PC, press **Enter VR**. `localhost` counts as a secure context.
- **Standalone over Wi-Fi:** `uv run serve.py --https`, open the printed `https://<lan-ip>:8443`
  in the Quest browser, accept the self-signed certificate warning, then press **Enter VR**.
  The viewer pulls three.js and Spark from a CDN, so the headset needs internet access.
- **File copy (as in VR-WORLD.md):** copy `runs/<name>/scene.ply` to the headset's Downloads
  folder and open it in the [StrikeLines viewer](https://strikelines.github.io/quest-splats-and-3d-models/).
  This viewer may need the scene flipped upright with the grips.

The viewer uses the `local` reference space, so the painting's camera = your head at session start.

## Results so far (RTX 5070 Ti, ComfyUI sharing the GPU)

| Run | Source | Depth | Splats | PLY | Desktop viewer (Edge) |
|---|---|---|---|---|---|
| `courtyard-01` | 34 s (1344×768, cold) | 8 s | 1.16 M | 75 MiB | 120 fps (vsync), load 0.36 s |
| `courtyard-01-quest` | reused | reused | 0.59 M | 38 MiB | not measured |
| `pano-01` | 166 s (2048×1024) | 133 s | 2.13 M | 138 MiB | not loaded |
| `pano-01-quest` | reused | reused | 0.53 M | 35 MiB | 120 fps, load 0.18 s |

The pano timings include GPU contention with other loaded ComfyUI models. Headset FPS is unmeasured.

Observations from the previews:
- The opening view matches the art in both modes. Parallax runs the right way: the arch slides across the courtyard.
- Perspective mode is a "window": leaning shows the edge of the painting's 70° frame. Pano mode is
  needed for the full-turn test, and it passes, apart from a visible **seam at 180°** (z-image does not
  wrap the image seamlessly).
- 10–20 cm leans are mostly hole-free with the background layer. The stretched background is
  blurry where the arch was, which is what WorldGen's generative inpainting would fix.
- Lotus depth is relative and 8-bit. `--depth-mode linear` (default) is correct for Lotus; disparity
  mapping flattened the courtyard to ~1.5 m. Absolute scale is a guess set by `--near/--far`.

## Next steps

1. Measure FPS on the headset and size up: try `*-quest` vs full-res, at 72 Hz.
2. Seamless panorama: circular padding / roll-and-inpaint the seam, or real outpainting (FLUX Fill once HF access exists).
3. Replace the stretched background with diffusion inpainting of the masked band.
4. Wrap as an OffloadMQ capability (`custom.world.splat`) per VR-WORLD.md §OffloadMQ integration.

## WorldGen-style 360 worlds from one picture (2026-11-24)

`worldgen_poc.py` reproduces WorldGen's image-to-scene path
([ZiYang-xie/WorldGen @ 7ce7b27](https://github.com/ZiYang-xie/WorldGen/tree/7ce7b2767fdf31e2727b69a2e61e2e950e3a017f))
on the local ComfyUI, without the gated FLUX Fill, the Nunchaku wheel or Linux:

| Stage | WorldGen | `worldgen_poc.py` |
|---|---|---|
| Place picture | `map_image_to_pano` (DA-2 rays) | pinhole → equirect at `--hfov`, `--pitch` |
| Outpaint 360° | FLUX.1 Fill [dev] + `worldgen_img2scene` LoRA | FLUX.1 Krea dev fp8 + public `worldgen_text2scene` LoRA (35 MB, Apache-2.0, in `C:\AI\models\loras`), masked-latent inpaint + DifferentialDiffusion at 1600×800 |
| Wrap seam | circular latent padding | roll 180° and re-inpaint a 12% band |
| Keep the art | paste original back | same, at the 2048×1024 canvas, feathered |
| Depth → splat | DA-2 → 1 Gaussian/pixel | Lotus on the panorama → `pipeline.build_splats` (pano, LDI background layer) |
| `use_sharp` | SHARP per cube face, scaled to DA-2 | `pano_sharp_poc.py`: SHARP per cube face, scaled to the Lotus depth (SHARP venv) |

```bash
uv run worldgen_poc.py --name torii-wg --image runs/torii-sharp/source.png --hfov 60 \
    --denoise-fill 0.95 --blend-frac 0.03 --prompt "a quiet Japanese Shinto shrine courtyard, ..."
~/.offload-agent/sharp/.venv/Scripts/python.exe pano_sharp_poc.py --name torii-wg
cd ../../oai/e2e && POC_POSES='[["turn 180",0,0,0,180]]' node ../../examples/vr-world-poc/capture.mjs torii-wg
```

The prompt defaults to the PNG's embedded ComfyUI prompt and gets WorldGen's
"A high quality 360 panorama photo of … 360 consistent, omnidirectional" wrapper.

Results (RTX 5070 Ti, warm ComfyUI):

| Run | Picture | Sphere covered | Outpaint + seam | Depth | Splats / PLY |
|---|---|---|---|---|---|
| `market-wg3` | 2048×1536 beach from a hill, hfov 90, pitch −25 | 10.5% | 38 s + 32 s | 3.5 s | 1.19 M / 77 MiB |
| `torii-wg` | 1080×1920 shrine, hfov 60 | 8.2% | 38 s + 31 s | 3.5 s | 1.20 M / 78 MiB |
| `temple-wg` | 1536² temple interior, hfov 80 | 9.3% | 38 s + 31 s | 3.5 s | 1.22 M / 79 MiB |
| `torii-wg-sharp360` | `torii-wg` panorama, 6 × 768² faces, keep 35% | — | 35 s SHARP (+8 s load), 7.0 GiB peak | — | 2.45 M / 131 MiB |

`runs/_capture/torii-compare.png` has Spark renders of `torii-sharp` / `torii-wg` /
`torii-wg-sharp360` at centre, lean 20 cm, turn 90° and turn 180°.

Findings:
- **Turning works.** world.sharp shows black past the frame; both panorama worlds show a
  coherent continuation (shrine garden, halls, lanterns; beach, huts, crowd; columned hall).
  The 180° seam is invisible after the roll-and-inpaint pass.
- **The opening view gets softer.** The picture covers ~8–10% of a 2048-wide panorama, so
  its 1080–2048 px shrink to ~300–400 px. Fix candidates: a 4096 canvas for the paste-back,
  or a hybrid (SHARP of the original picture in front, panorama world for the rest).
- **Use denoise 1.0.** At `--denoise-fill 0.95` FLUX frames the picture with large near
  objects (a second torii, temple columns) *and* leaves a diagonal patch-grid pattern
  next to the picture, because 5% of the smooth colour seed survives into sampling. At
  1.0 both go away (FLUX tends to put a natural occluder — a pillar — on the picture
  edge). The seed must still be the picture's mean colour if denoise is lowered (an
  all-black seed produced a dark hut around the picture).
- **Paste back with a narrow ramp.** Differential diffusion leaves the same patch-grid
  pattern wherever the mask is partial, so the wide generation feather must not be the
  paste-back alpha: the original is pasted over its whole footprint with a ~4 px inward
  ramp (`worldgen_poc.py` does this; earlier runs used the wide feather).
- **Pitch matters.** Pictures shot from above need `--pitch` (market: −25°), otherwise an
  aerial view floats above an eye-level world. The viewer still starts level, so the
  picture is then below the start gaze.
- **SHARP per cube face** gives crisper geometry and joins cleanly at face edges, but the
  6 × 1.18 M Gaussians need decimation for Quest/OAI limits; random 35% leaves visible
  speckle. Per-face scale factors (×2.4–×9.4) show Lotus is a weak anchor, especially for
  up/down faces. DA-2 (WorldGen's panoramic depth) would be the real fix.

## WorldMirror 2.0 on a single picture — plan A1 (2026-11-26)

`worldmirror_poc.py` is step A1 of [the quality plan](../../docs/worlds-quality-plan.md):
Tencent HY-World 2.0's feed-forward model (`HY-WorldMirror-2.0`, 1.2 B) run alone on
each test picture, compared with the SHARP run of the same `source.png`.

> **Licence.** HY-World 2.0's Community License does **not** apply in the EU, UK or South
> Korea; using the code, weights *or outputs* there is unlicensed. The operator confirmed
> this machine is in the licensed territory. Nothing of Tencent's is vendored in the repo.

### Setup (outside the repo, ~11 GB)

```bash
mkdir -p E:/hyworld-poc && cd E:/hyworld-poc
git clone --depth 1 --filter=blob:none --sparse https://github.com/Tencent-Hunyuan/HY-World-2.0.git src
(cd src && git fetch --depth 1 origin df9988efb87bfc0f4947eb3889411cf957478b06 &&
   git checkout df9988efb87bfc0f4947eb3889411cf957478b06 && git sparse-checkout set hyworld2/worldrecon)
export UV_CACHE_DIR='E:\hyworld-poc\uv-cache'
uv venv --python 3.11 venv
uv pip install --python venv/Scripts/python.exe torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu128
uv pip install --python venv/Scripts/python.exe numpy==1.26.4 einops safetensors omegaconf \
    opencv-python-headless==4.10.0.84 pillow plyfile onnxruntime huggingface_hub scipy gsplat==1.5.3 trimesh requests matplotlib tqdm
venv/Scripts/python.exe -c "from huggingface_hub import snapshot_download as d; d('tencent/HY-World-2.0', allow_patterns=['HY-WorldMirror-2.0/*'], revision='d78a16c91c7a56488894a1c8de4f5c7cc28aa8b0', local_dir=r'E:\hyworld-poc\weights')"
```

No WSL, ComfyUI nodes or FlashAttention build needed: the only blocker was a hard
`flash_attn` import, which the script satisfies with a shim over torch's SDPA. The
official sky mask downloads `skyseg.onnx` (third party, `JianyuanWang/skyseg`) on first use.

### Run

```bash
cd examples/vr-world-poc
PY=E:/hyworld-poc/venv/Scripts/python.exe
$PY worldmirror_poc.py                                            # runs/<scene>-wm (official post-processing)
$PY worldmirror_poc.py --suffix wm-full --no-sky-mask --no-edge-mask --no-voxel-prune
uv run serve.py    # then, from oai/e2e, capture.mjs with POC_POSES for each run
$PY a1_sheets.py   # runs/_capture/a1-<scene>-{a,b}.png (needs the sharp, wm, wm-dense, wm-nosky, wm-noedge, wm-full captures)
```

Each run keeps the untouched `gaussians.ply` and writes a viewer `scene.ply`: camera-0
frame, one global scale to SHARP's depth, opacity re-encoded as a 3DGS logit.

### Results (RTX 5070 Ti, official post-processing)

| Scene | Inference / total | Peak VRAM | Splats / PLY (SHARP: 1.18 M / 63 MiB) | HFOV, WM vs SHARP | Scale to SHARP | Depth error, median / p90 | Log-depth corr. |
|---|---|---|---|---|---|---|---|
| torii | 0.40 / 1.9 s | 7.8 GiB | 210 k / 11 MiB | 32° / 39° | ×10.7 | 12.0% / 40% | 0.97 |
| temple | 0.74 / 2.6 s | 9.3 GiB | 288 k / 15 MiB | 47° / 54° | ×6.1 | 3.5% / 8% | 0.89 |
| courtyard | 0.42 / 1.7 s | 7.8 GiB | 116 k / 6 MiB | 63° / 64° | ×13.5 | 1.7% / 25% | 0.99 |
| market | 0.54 / 2.2 s | 8.5 GiB | 248 k / 13 MiB | 46° / 60° | ×15.5 | 4.6% / 28% | 0.99 |
| forest | 0.47 / 1.8 s | 8.1 GiB | 104 k / 6 MiB | 28° / 62° | ×5.3 | **34% / 155%** | 0.90 |

Model load 12–17 s. Depth error compares near-surface depth on a 96×96 image grid after
one scale factor; SHARP is the reference, not ground truth (neither has EXIF here, so
SHARP assumed a 30 mm lens).

Findings (Spark renders at the plan's poses):

- **WorldMirror alone does not beat SHARP on any of the five scenes.** It predicts one
  Gaussian per pixel and nothing behind it, so every lean opens a black silhouette behind
  foreground objects where SHARP shows plausible (if smeared) background. At 40 cm the
  silhouettes dominate the temple and forest views.
- **Geometry inside the frame is close to SHARP** (courtyard, temple, market), weaker on
  torii, and fails on the foliage/portrait scene.
- **Not metric.** Depth needs a ×5–15 scale taken from another source.
- **Specific failures:** forest's face and chainsaw are smeared (90th-percentile splat
  sigma ~9 px of the 952 px input, several times SHARP's relative to the frame); temple's glowing sun disc sits at 0.76 m instead of ~3 m, in
  front of the statue.
- **The official post-processing hurts a single view.** The sky mask deletes the sky
  (black arch in courtyard); the edge mask draws dark outlines round every depth edge.
  With both off (`wm-full`) the centre view of torii and market is close to SHARP's.
- **Upstream quirks:** the PLY stores opacity as a probability, not the 3DGS logit; the
  voxel merge (and the model's own `prune_gs`) uses the confidence *weight* as opacity and
  ignores the opacity head (median ~0.18 raw); predicted fx and fy differ by 2–8%, which a
  square-pixel viewer shows as a slight stretch.
- **VRAM contention matters.** With a 6 GiB Ollama model also loaded, one inference took
  98 s instead of 0.4 s (spill to system memory).

Not tested: headset playback and FPS; WorldMirror with several views (its intended use,
A3.1) or with SHARP's intrinsics as a prior.

## Filling hidden areas — Plan B, phase B0 (2026-11-26)

Renders a SHARP scene from offset head poses and marks what the picture never showed, the
input for generative filling. No generation yet. Results and how to reproduce:
[docs/worlds-fill-plan.md](../../docs/worlds-fill-plan.md#b0-renderer-and-masks-no-generation).

| Script (SHARP venv's python) | Does |
|---|---|
| `sharp_fill_poc.py <scene>...` | SHARP prediction, renders, hole / unseen masks, `runs/_fill/<scene>/sheet.png` |
| `torch_splat.py` | Pure-PyTorch splat renderer (no compiled extension), culls like Spark |
| `torch_splat_check.py` | Renderer self-check on two synthetic planes |
| `sharp_fill_compare.py <scene>...` | Side by side with Spark captures of the same poses |
| `gpu_guard.py` | Refuses to start with under 10 GiB of free RAM or commit |

## Productized version

`world.mirror` (agent `exec/world/mirror*.py`, `omq mirror`, GUI **WorldMirror**) runs
WorldMirror with both masks and the voxel merge off by default (`cleanup` turns them
on) and takes its scale from SHARP; `omq mirror install` can adopt the directory built
above (`omq mirror config --dir E:/hyworld-poc`). It is there for headset comparison.

`world.pano360` (agent `exec/world/pano360.py`, `omq pano360`, GUI **360° Worlds**) ships
the WorldGen path with the fixes above as defaults; OAI `/app/worlds` offers it as
"WorldGen 360°" with a surroundings prompt and camera tilt. The SHARP-per-cube-face
variant stays a PoC.


Use OAI `/app/worlds` and the `world.splat` agent executor for persistent jobs,
signed headset links and the integrated viewer. See [VR Worlds](../../docs/oai-worlds.md).
