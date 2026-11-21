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

## Productized version

Use OAI `/app/worlds` and the `world.splat` agent executor for persistent jobs,
signed headset links and the integrated viewer. See [VR Worlds](../../docs/oai-worlds.md).
