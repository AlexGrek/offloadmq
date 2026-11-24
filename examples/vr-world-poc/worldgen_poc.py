# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26", "pillow>=10", "requests>=2.31"]
# ///
"""WorldGen-style image -> 360 world, on the local ComfyUI.

Reproduces WorldGen's image-to-scene path (ZiYang-xie/WorldGen @ 7ce7b27,
`WorldGen.generate_pano` + `_generate_world`) without its Linux-only stack:

  1. project   - place the perspective picture on a 2:1 equirectangular canvas at an
                 assumed horizontal FOV (WorldGen: `map_image_to_pano`)
  2. outpaint  - fill the rest of the sphere with FLUX.1-dev + WorldGen's public
                 `worldgen_text2scene` panorama LoRA, masked-latent inpainting at
                 1600x800 (WorldGen: FLUX.1 Fill + img2scene LoRA, gated)
  3. seam      - roll the panorama by 180 deg and re-inpaint the wrap seam
                 (WorldGen: circular latent padding, `blend_extend`)
  4. paste     - put the original pixels back at full canvas resolution
  5. world     - Lotus depth on the panorama -> pipeline.py's pano splats + previews
                 (WorldGen: DA-2 panoramic depth -> one Gaussian per pixel)

`pano_sharp_poc.py` then turns the same panorama into SHARP Gaussians per cube face
(WorldGen's `use_sharp` path).

Usage:
  uv run worldgen_poc.py --name market-wg --image C:/AI/output/Krea2_turbo_07674_.png
  uv run worldgen_poc.py --name market-wg --reuse-pano   # redo depth/splats only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

import pipeline as P

HERE = Path(__file__).resolve().parent
PREFIX = "A high quality 360 panorama photo of"
SUFFIX = "HDR, RAW, 360 consistent, omnidirectional"


# --------------------------------------------------------------------------- projection


def pano_dirs(w: int, h: int) -> np.ndarray:
    """Unit rays per equirect pixel, OpenCV frame (x right, y down, z forward);
    same convention as pipeline.backproject(mode='pano')."""
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    lon = (u / w - 0.5) * 2 * np.pi
    lat = (0.5 - v / h) * np.pi
    return np.stack([np.cos(lat) * np.sin(lon), -np.sin(lat), np.cos(lat) * np.cos(lon)], -1)


def bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1.001)
    y = np.clip(y - 0.5, 0, h - 1.001)
    x0, y0 = x.astype(np.int64), y.astype(np.int64)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    a, b = img[y0, x0], img[y0, x0 + 1]
    c, d = img[y0 + 1, x0], img[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def project_to_pano(src: Image.Image, hfov: float, w: int, h: int, pitch: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """Returns (rgb float [0,1] HxWx3, covered bool HxW) for a camera at lon 0.
    `pitch` in degrees, negative = camera looks down (the picture lands below the horizon)."""
    img = np.asarray(src.convert("RGB"), dtype=np.float32) / 255.0
    sh, sw = img.shape[:2]
    f = 0.5 * sw / np.tan(np.radians(hfov) / 2)
    dw = pano_dirs(w, h)
    a = np.radians(-pitch)  # down-tilt; OpenCV y points down
    down = np.array([0.0, np.cos(a), -np.sin(a)])
    fwd = np.array([0.0, np.sin(a), np.cos(a)])
    d = np.stack([dw[..., 0], dw @ down, dw @ fwd], -1)  # world ray -> camera frame
    z = d[..., 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        px = d[..., 0] / z * f + sw / 2
        py = d[..., 1] / z * f + sh / 2
    covered = (z > 1e-3) & (px >= 0) & (px < sw) & (py >= 0) & (py < sh)
    rgb = np.zeros((h, w, 3), np.float32)
    rgb[covered] = bilinear(img, px[covered], py[covered])
    return rgb, covered


def pull_push_fill(rgb: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Fill invalid pixels with a smooth extension of the valid ones (mip pull-push).
    Only seeds the inpaint with plausible colour; the sampler regenerates it."""
    h, w = valid.shape
    wgt = valid.astype(np.float32)
    levels = [(rgb * wgt[..., None], wgt)]
    while min(levels[-1][1].shape) > 4:
        c, m = levels[-1]
        nh, nw = max(c.shape[0] // 2, 1), max(c.shape[1] // 2, 1)
        c2 = np.stack([np.asarray(Image.fromarray(c[..., i]).resize((nw, nh), Image.BOX)) for i in range(3)], -1)
        m2 = np.asarray(Image.fromarray(m).resize((nw, nh), Image.BOX))
        levels.append((c2, m2))
    c, m = levels[-1]
    mean = rgb[valid].mean(0) if valid.any() else np.full(3, 0.5, np.float32)
    cur = np.where((m > 0)[..., None], c / np.maximum(m, 1e-6)[..., None], mean)
    for c, m in reversed(levels[:-1]):
        lh, lw = m.shape
        up = np.stack([np.asarray(Image.fromarray(cur[..., i]).resize((lw, lh), Image.BILINEAR)) for i in range(3)], -1)
        own = c / np.maximum(m, 1e-6)[..., None]
        a = np.clip(m * 4, 0, 1)[..., None]
        cur = own * a + up * (1 - a)
    return np.where(valid[..., None], rgb, cur)


def feather(mask: np.ndarray, radius: int) -> np.ndarray:
    """1 = regenerate. Ramps `radius` px into the kept region so the seam blends."""
    hard = Image.fromarray((mask * 255).astype(np.uint8))
    soft = np.asarray(hard.filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255.0
    return np.maximum(mask.astype(np.float32), np.clip(soft * 2, 0, 1))


def to_rgba(rgb: np.ndarray, regen: np.ndarray) -> Image.Image:
    """ComfyUI LoadImage turns alpha into MASK = 1 - alpha."""
    a = ((1 - regen) * 255).round().astype(np.uint8)
    c = (np.clip(rgb, 0, 1) * 255).round().astype(np.uint8)
    return Image.fromarray(np.dstack([c, a]), "RGBA")


# --------------------------------------------------------------------------- ComfyUI


def outpaint_workflow(image_name: str, prompt: str, w: int, h: int, seed: int, denoise: float, a) -> dict:
    """FLUX.1-dev (+ WorldGen pano LoRA) masked-latent inpainting with differential diffusion."""
    return {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": a.flux_model, "weight_dtype": "default"}},
        "lora": {"class_type": "LoraLoaderModelOnly",
                 "inputs": {"lora_name": a.lora, "strength_model": a.lora_strength, "model": ["unet", 0]}},
        "msf": {"class_type": "ModelSamplingFlux",
                "inputs": {"max_shift": 1.15, "base_shift": 0.5, "width": w, "height": h, "model": ["lora", 0]}},
        "dd": {"class_type": "DifferentialDiffusion", "inputs": {"model": ["msf", 0]}},
        "clip": {"class_type": "DualCLIPLoader",
                 "inputs": {"clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp8_e4m3fn_scaled.safetensors",
                            "type": "flux", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["clip", 0]}},
        "guid": {"class_type": "FluxGuidance", "inputs": {"guidance": a.guidance, "conditioning": ["pos", 0]}},
        "neg": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["pos", 0]}},
        "load": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "scale": {"class_type": "ImageScale",
                  "inputs": {"image": ["load", 0], "upscale_method": "lanczos", "width": w, "height": h, "crop": "disabled"}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["scale", 0], "vae": ["vae", 0]}},
        "nm": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["enc", 0], "mask": ["load", 1]}},
        "ks": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": a.steps, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
            "denoise": denoise,
            "model": ["dd", 0], "positive": ["guid", 0], "negative": ["neg", 0], "latent_image": ["nm", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"filename_prefix": "worldgen-poc", "images": ["dec", 0]}},
    }


def run_inpaint(comfy: P.Comfy, rgba: Image.Image, path: Path, prompt: str, w: int, h: int, seed: int,
                denoise: float, a) -> np.ndarray:
    rgba.save(path)
    name = comfy.upload(path)
    out = comfy.run(outpaint_workflow(name, prompt, w, h, seed, denoise, a), timeout=1800)[0].convert("RGB")
    return np.asarray(out, np.float32) / 255.0


def embedded_prompt(path: Path) -> str | None:
    """Longest CLIPTextEncode text in a ComfyUI PNG's `prompt` metadata."""
    try:
        raw = Image.open(path).info.get("prompt")
        texts = [n["inputs"]["text"] for n in json.loads(raw).values()
                 if isinstance(n.get("inputs", {}).get("text"), str)] if raw else []
        return max(texts, key=len) if texts else None
    except (OSError, ValueError, AttributeError):
        return None


def resize(a: np.ndarray, w: int, h: int, method=Image.LANCZOS) -> np.ndarray:
    if a.ndim == 2:
        return np.asarray(Image.fromarray(a.astype(np.float32)).resize((w, h), Image.BILINEAR), np.float32)
    return np.asarray(Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).resize((w, h), method), np.float32) / 255.0


# --------------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True)
    ap.add_argument("--image", type=Path, help="perspective source picture")
    ap.add_argument("--prompt", help="scene description (default: the PNG's embedded ComfyUI prompt)")
    ap.add_argument("--hfov", type=float, default=70.0, help="assumed horizontal FOV of the picture")
    ap.add_argument("--pitch", type=float, default=0.0, help="camera pitch in degrees, negative = looking down")
    ap.add_argument("--blend-frac", type=float, default=0.015,
                    help="feather into the picture as a fraction of the canvas width (repainted margin)")
    ap.add_argument("--canvas", type=int, default=2048, help="final panorama width (height = width/2)")
    ap.add_argument("--gen-width", type=int, default=1600, help="outpaint resolution (WorldGen default 1600)")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--steps", type=int, default=28)
    ap.add_argument("--guidance", type=float, default=4.0)
    ap.add_argument("--denoise-fill", type=float, default=1.0)
    ap.add_argument("--denoise-seam", type=float, default=0.85)
    ap.add_argument("--seam-frac", type=float, default=0.12, help="seam band width as a fraction of the width")
    ap.add_argument("--flux-model", default="flux1-krea-dev_fp8_scaled.safetensors")
    ap.add_argument("--lora", default="worldgen_text2scene.safetensors")
    ap.add_argument("--lora-strength", type=float, default=1.0)
    ap.add_argument("--max-width", type=int, default=1536, help="splat budget passed to pipeline.build_splats")
    ap.add_argument("--fill-lean", type=float, default=0.25)
    ap.add_argument("--near", type=float, default=1.2)
    ap.add_argument("--far", type=float, default=50.0)
    ap.add_argument("--reuse-pano", action="store_true", help="skip stages 1-4, reuse pano.png")
    ap.add_argument("--comfy", default="http://127.0.0.1:6966")
    a = ap.parse_args()

    out = HERE / "runs" / a.name
    out.mkdir(parents=True, exist_ok=True)
    comfy = P.Comfy(a.comfy)
    meta_path = out / "worldgen.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if a.reuse_pano and meta_path.exists() else {}
    timings: dict[str, float] = meta.get("timings", {})
    W, H = a.canvas, a.canvas // 2
    gw, gh = a.gen_width, a.gen_width // 2

    if not a.reuse_pano:
        if not a.image:
            ap.error("--image is required unless --reuse-pano")
        src = Image.open(a.image).convert("RGB")
        src.save(out / "input.png")
        prompt = a.prompt or embedded_prompt(a.image) or "a scene"
        full_prompt = f"{PREFIX} {prompt} {SUFFIX}"
        seed = a.seed if a.seed is not None else random.randint(0, 2**48)

        t0 = time.time()
        rgb, covered = project_to_pano(src, a.hfov, W, H, a.pitch)
        regen_full = feather(~covered, max(4, int(W * a.blend_frac)))
        seeded = pull_push_fill(rgb, covered)
        Image.fromarray((rgb * 255).astype(np.uint8)).save(out / "projected.png")
        timings["project_s"] = round(time.time() - t0, 2)
        print(f"[1/5] projected {src.size} at hfov {a.hfov} pitch {a.pitch} -> {W}x{H}, covers {covered.mean() * 100:.1f}% of the sphere")

        t0 = time.time()
        g_seed = resize(seeded, gw, gh)
        g_regen = resize(regen_full, gw, gh)
        raw = run_inpaint(comfy, to_rgba(g_seed, g_regen), out / "_fill.png", full_prompt, gw, gh, seed, a.denoise_fill, a)
        Image.fromarray((raw * 255).astype(np.uint8)).save(out / "pano_raw.png")
        timings["outpaint_s"] = round(time.time() - t0, 2)
        print(f"[2/5] outpainted {gw}x{gh} in {timings['outpaint_s']}s")

        t0 = time.time()
        rolled = np.roll(raw, gw // 2, axis=1)
        band = np.zeros((gh, gw), bool)
        bw = int(gw * a.seam_frac / 2)
        band[:, gw // 2 - bw: gw // 2 + bw] = True
        regen_seam = feather(band, max(4, gw // 64))
        fixed = run_inpaint(comfy, to_rgba(rolled, regen_seam), out / "_seam.png", full_prompt, gw, gh, seed + 1, a.denoise_seam, a)
        # Only take the band from the second pass; everything else stays as generated.
        fixed = rolled * (1 - regen_seam[..., None]) + fixed * regen_seam[..., None]
        pano_gen = np.roll(fixed, -(gw // 2), axis=1)
        timings["seam_s"] = round(time.time() - t0, 2)
        print(f"[3/5] seam band {2 * bw}px re-inpainted in {timings['seam_s']}s")

        t0 = time.time()
        up = resize(pano_gen, W, H)
        # Narrow inward ramp only: FLUX leaves a patch-grid pattern where the mask is partial.
        hard = Image.fromarray(covered.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(4))
        keep = np.clip(np.asarray(hard, np.float32) / 255.0 * 2 - 1, 0, 1) * covered
        pano = rgb * keep[..., None] + up * (1 - keep[..., None])
        Image.fromarray((np.clip(pano, 0, 1) * 255).round().astype(np.uint8)).save(out / "pano.png")
        timings["paste_s"] = round(time.time() - t0, 2)
        print(f"[4/5] pasted original back -> pano.png {W}x{H}")
        for tmp in ("_fill.png", "_seam.png"):
            (out / tmp).unlink(missing_ok=True)

        meta = {
            "name": a.name, "generator": "worldgen-comfy-poc", "source_path": str(a.image),
            "input_sha256": hashlib.sha256(a.image.read_bytes()).hexdigest(), "source_size": list(src.size),
            "prompt": full_prompt, "seed": seed, "coverage": float(covered.mean()),
            "settings": {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(a).items()},
        }

    # 5. world: Lotus depth on the panorama, then the existing pano splatter + previews.
    t0 = time.time()
    pano_img = Image.open(out / "pano.png").convert("RGB")
    pano_img.save(out / "source.png")  # what index.html / pipeline previews call the colour image
    if a.reuse_pano and (out / "depth.png").exists():
        depth = Image.open(out / "depth.png")
    else:
        depth = comfy.run(P.lotus_depth_workflow(comfy.upload(out / "source.png")))[0]
        depth.save(out / "depth.png")
    timings["depth_s"] = round(time.time() - t0, 2)
    print(f"[5/5] Lotus depth {depth.size} in {timings['depth_s']}s")

    sargs = argparse.Namespace(mode="pano", hfov=90.0, near=a.near, far=a.far, depth_mode="linear",
                               fill_lean=a.fill_lean, fill_jump=1.5, depth_smooth=3, max_width=a.max_width,
                               flip_depth=False, edge_ratio=1.15, drop_edges=False, splat_scale=0.65)
    t0 = time.time()
    sp = P.build_splats(pano_img, depth, sargs)
    ply = out / "scene.ply"
    P.write_ply(ply, sp["xyz"], sp["rgb"], sp["scales"], sp["quats"], sp["opacity"])
    timings["splat_s"] = round(time.time() - t0, 2)

    t0 = time.time()
    pw, ph = 672, 384
    xyz, col = sp["xyz"], sp["rgb"]
    tiles = [("input", Image.open(out / "input.png").convert("RGB").resize((pw, ph))),
             ("projected (black = to generate)", Image.open(out / "projected.png").convert("RGB").resize((pw, ph))),
             ("outpainted panorama", pano_img.resize((pw, ph))),
             ("Lotus depth (white = near)", depth.convert("RGB").resize((pw, ph)))]
    for label, eye, yaw in [("center", (0, 0, 0), 0), ("lean R 20cm", (0.20, 0, 0), 0),
                            ("step fwd 30cm", (0, 0, 0.30), 0), ("turn 90", (0, 0, 0), 90),
                            ("turn 180 (seam)", (0, 0, 0), 180), ("turn 270", (0, 0, 0), 270)]:
        im = P.render_preview(xyz, col, eye, (pw // 2, ph // 2), 90.0, yaw)
        tiles.append((label, im.resize((pw, ph), Image.NEAREST)))
    P.contact_sheet(tiles, 2).save(out / "previews.png")
    timings["preview_s"] = round(time.time() - t0, 2)

    z = sp["z"]
    meta.update({
        "splats": int(len(xyz)), "splats_fg": int(sp["n_fg"]), "splats_bg": int(sp["n_bg"]),
        "ply_bytes": ply.stat().st_size, "depth_range_m": [float(z.min()), float(z.max())],
        "timings": timings, "viewer": {"eye_height_m": 1.6}, "mode": "pano",
    })
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (out / "run.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    runs = sorted(p.parent.name for p in (HERE / "runs").glob("*/scene.ply"))
    (HERE / "runs" / "index.json").write_text(json.dumps(runs), encoding="utf-8")
    print(f"done -> {out}: {len(xyz):,} splats, {ply.stat().st_size / 2**20:.1f} MiB, timings {timings}")


if __name__ == "__main__":
    main()
