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

## Productized version

`world.pano360` (agent `exec/world/pano360.py`, `omq pano360`, GUI **360° Worlds**) ships
the WorldGen path with the fixes above as defaults; OAI `/app/worlds` offers it as
"WorldGen 360°" with a surroundings prompt and camera tilt. The SHARP-per-cube-face
variant stays a PoC.


Use OAI `/app/worlds` and the `world.splat` agent executor for persistent jobs,
signed headset links and the integrated viewer. See [VR Worlds](../../docs/oai-worlds.md).
