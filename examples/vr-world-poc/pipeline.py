# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.26", "pillow>=10", "requests>=2.31"]
# ///
"""VR-WORLD.md proof of concept: art -> depth -> Gaussian splat PLY.

Instead of WorldGen (gated FLUX.1 Fill + Linux-only Nunchaku wheel), this drives the
ComfyUI instance already on the box:

  1. txt2img  - z-image turbo (skipped with --image)
  2. depth    - Lotus-D, using the repo's img-utils/depth reference workflow
  3. splat    - one oriented Gaussian per pixel, back-projected through a pinhole
                (perspective) or a sphere (pano), written as a standard 3DGS PLY
  4. previews - CPU re-renders from leaned viewpoints to check parallax without a headset

Usage:
  uv run pipeline.py --name courtyard-01 --prompt "..."
  uv run pipeline.py --name mine --image path/to/art.png
  uv run pipeline.py --name pano-01 --mode pano --prompt "..."
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
import time
import uuid
from pathlib import Path

import numpy as np
import requests
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEPTH_WORKFLOW = REPO / "agent_v2" / "workflows" / "img-utils" / "depth" / "depth.json"
SH_C0 = 0.28209479177387814


# --------------------------------------------------------------------------- ComfyUI


class Comfy:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.client_id = uuid.uuid4().hex

    def upload(self, path: Path) -> str:
        with path.open("rb") as fh:
            r = requests.post(
                f"{self.base}/upload/image",
                files={"image": (path.name, fh, "image/png")},
                data={"overwrite": "true"},
                timeout=60,
            )
        r.raise_for_status()
        return r.json()["name"]

    def run(self, workflow: dict, timeout: float = 900) -> list[Image.Image]:
        r = requests.post(
            f"{self.base}/prompt",
            json={"prompt": workflow, "client_id": self.client_id},
            timeout=30,
        )
        if r.status_code != 200:
            raise RuntimeError(f"ComfyUI rejected workflow: {r.text}")
        pid = r.json()["prompt_id"]
        deadline = time.time() + timeout
        while time.time() < deadline:
            h = requests.get(f"{self.base}/history/{pid}", timeout=30).json()
            if pid in h:
                entry = h[pid]
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(f"ComfyUI error: {json.dumps(status)[:2000]}")
                images = []
                for out in entry.get("outputs", {}).values():
                    for im in out.get("images", []):
                        v = requests.get(f"{self.base}/view", params=im, timeout=60)
                        v.raise_for_status()
                        from io import BytesIO

                        images.append(Image.open(BytesIO(v.content)).copy())
                if images or status.get("completed"):
                    return images
            time.sleep(1.0)
        raise TimeoutError(f"ComfyUI prompt {pid} did not finish in {timeout}s")


def zimage_turbo_workflow(prompt: str, width: int, height: int, seed: int) -> dict:
    return {
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": "z_image_turbo_bf16.safetensors", "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "lumina2", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
        "shift": {"class_type": "ModelSamplingAuraFlow", "inputs": {"shift": 3, "model": ["unet", 0]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["clip", 0]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["clip", 0]}},
        "latent": {"class_type": "EmptySD3LatentImage",
                   "inputs": {"width": width, "height": height, "batch_size": 1}},
        "ks": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 8, "cfg": 1.0, "sampler_name": "res_multistep",
            "scheduler": "simple", "denoise": 1.0, "model": ["shift", 0],
            "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["latent", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"filename_prefix": "vr-world-poc", "images": ["dec", 0]}},
    }


def lotus_depth_workflow(uploaded_name: str) -> dict:
    wf = copy.deepcopy(json.loads(DEPTH_WORKFLOW.read_text(encoding="utf-8")))
    for node in wf.values():
        if node["class_type"] == "LoadImage":
            node["inputs"]["image"] = uploaded_name
        if node["class_type"] == "SaveImage":
            node["inputs"]["filename_prefix"] = "vr-world-poc-depth"
    return wf


# --------------------------------------------------------------------------- geometry


def depth_from_map(v: np.ndarray, mode: str, near: float, far: float) -> np.ndarray:
    """v in [0,1], 1 = near (Lotus output is inverted so near is white)."""
    v = np.clip(v, 0.0, 1.0)
    if mode == "disparity":
        inv = v * (1.0 / near - 1.0 / far) + 1.0 / far
        return 1.0 / inv
    return near + (1.0 - v) * (far - near)


def edge_mask(z: np.ndarray, ratio: float) -> np.ndarray:
    """True where a pixel sits on a depth discontinuity (3x3 max/min ratio)."""
    p = np.pad(z, 1, mode="edge")
    stack = np.stack([p[dy:dy + z.shape[0], dx:dx + z.shape[1]] for dy in range(3) for dx in range(3)])
    return stack.max(0) / stack.min(0) > ratio


def _shift(a: np.ndarray, dy: int, dx: int, fill) -> np.ndarray:
    out = np.empty_like(a)
    out[...] = fill
    h, w = a.shape[:2]
    ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
    xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
    out[yd, xd] = a[ys, xs]
    return out


def background_layer(rgb: np.ndarray, z: np.ndarray, iters: int, jump: float):
    """Layered-depth-image lite: grow the far side of every depth edge in behind the
    near side, so leaning reveals stretched background instead of a hole.

    Returns (mask, colour, depth) of pixels that need a hidden background splat.
    A neighbour may feed pixel p only if it lies `jump`x farther than p's own surface,
    so foreground interiors never leak into the layer behind themselves."""
    fz = z.copy()
    fc = rgb.copy()
    filled = np.zeros(z.shape, bool)
    for _ in range(iters):
        acc_c = np.zeros_like(rgb)
        acc_z = np.zeros_like(z)
        n = np.zeros_like(z)
        src_z = np.where(filled, fz, z)
        src_c = np.where(filled[..., None], fc, rgb)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            nz = _shift(src_z, dy, dx, 0.0)
            nc = _shift(src_c, dy, dx, 0.0)
            ok = (nz > z * jump) & ~filled
            acc_c += nc * ok[..., None]
            acc_z += nz * ok
            n += ok
        new = n > 0
        if not new.any():
            break
        fc[new] = acc_c[new] / n[new, None]
        fz[new] = acc_z[new] / n[new]
        filled |= new
    return filled, fc, fz


def quat_look(dirs: np.ndarray) -> np.ndarray:
    """Quaternion (w,x,y,z) rotating +Z onto each unit direction (disc faces the eye)."""
    z = np.array([0.0, 0.0, 1.0])
    d = dirs / np.linalg.norm(dirs, axis=1, keepdims=True)
    axis = np.cross(np.broadcast_to(z, d.shape), d)
    w = 1.0 + d @ z
    q = np.concatenate([w[:, None], axis], axis=1)
    bad = w < 1e-6
    q[bad] = [0.0, 1.0, 0.0, 0.0]
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def backproject(rgb: np.ndarray, z: np.ndarray, mode: str, hfov_deg: float):
    """Returns xyz (OpenCV: x right, y down, z forward), per-pixel footprint, ray dirs."""
    h, w = z.shape
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    if mode == "pano":
        lon = (u / w - 0.5) * 2 * np.pi
        lat = (0.5 - v / h) * np.pi
        dirs = np.stack([np.cos(lat) * np.sin(lon), -np.sin(lat), np.cos(lat) * np.cos(lon)], -1)
        xyz = dirs * z[..., None]
        foot = z * (2 * np.pi / w) * np.maximum(np.cos(lat), 0.05)
        foot_v = z * (np.pi / h)
        return xyz, np.stack([foot, foot_v], -1), dirs
    f = 0.5 * w / np.tan(np.radians(hfov_deg) / 2)
    x = (u - w / 2) / f
    y = (v - h / 2) / f
    dirs = np.stack([x, y, np.ones_like(x)], -1)
    xyz = dirs * z[..., None]
    foot = z / f * np.sqrt(1 + x * x + y * y)
    return xyz, np.stack([foot, foot], -1), dirs


def write_ply(path: Path, xyz, rgb, scales, quats, opacity) -> None:
    n = xyz.shape[0]
    fields = (["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
               "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"])
    data = np.zeros((n, len(fields)), dtype=np.float32)
    data[:, 0:3] = xyz
    data[:, 6:9] = (rgb - 0.5) / SH_C0
    data[:, 9] = np.log(opacity / (1 - opacity))
    data[:, 10:13] = np.log(scales)
    data[:, 13:17] = quats
    header = "ply\nformat binary_little_endian 1.0\n" f"element vertex {n}\n"
    header += "".join(f"property float {f}\n" for f in fields) + "end_header\n"
    with path.open("wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(data.tobytes())


def build_splats(rgb_img: Image.Image, depth_img: Image.Image, args) -> dict:
    if args.max_width and rgb_img.width > args.max_width:
        # Splat budget: Quest standalone wants well under ~1M splats.
        rgb_img = rgb_img.resize((args.max_width, round(rgb_img.height * args.max_width / rgb_img.width)),
                                 Image.LANCZOS)
    rgb =np.asarray(rgb_img.convert("RGB"), dtype=np.float32) / 255.0
    dmap = depth_img.convert("L").resize(rgb_img.size, Image.BICUBIC)
    v = np.asarray(dmap, dtype=np.float32) / 255.0
    # The depth PNG is 8-bit: in the near range one grey level is ~15% of the distance,
    # which terraces surfaces into false edges. Smooth in float before mapping.
    for _ in range(args.depth_smooth):
        v = sum(_shift(v, dy, dx, 0.0) for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9.0
        v[[0, -1], :] = v[[1, -2], :]
        v[:, [0, -1]] = v[:, [1, -2]]
    if args.flip_depth:
        v = 1.0 - v
    z = depth_from_map(v, args.depth_mode, args.near, args.far)
    xyz, foot, dirs = backproject(rgb, z, args.mode, args.hfov)

    edges = edge_mask(z, args.edge_ratio)
    keep = ~edges if args.drop_edges else np.ones_like(edges)

    flat = lambda a: a.reshape(-1, a.shape[-1]) if a.ndim == 3 else a.reshape(-1)  # noqa: E731
    k = flat(keep)
    xyz_f, rgb_f, foot_f, dirs_f = flat(xyz)[k], flat(rgb)[k], flat(foot)[k], flat(dirs)[k]
    s = args.splat_scale
    # Flat discs facing the eye: footprint-sized in-plane, thin along the ray.
    scales = np.stack([foot_f[:, 0] * s, foot_f[:, 1] * s, np.minimum(foot_f[:, 0], foot_f[:, 1]) * 0.15], 1)
    quats = quat_look(dirs_f)
    opacity = np.full(len(xyz_f), 0.97, dtype=np.float32)
    n_fg = len(xyz_f)

    n_bg = 0
    if args.fill_lean > 0:
        # Background layer at half resolution: the pixel shift a lean of `fill_lean`
        # metres causes between the nearest and farthest surface bounds the band width.
        h, w = z.shape
        hz = np.asarray(Image.fromarray(z).resize((w // 2, h // 2), Image.NEAREST))
        hrgb = np.asarray(Image.fromarray((rgb * 255).astype(np.uint8)).resize((w // 2, h // 2), Image.BOX),
                          dtype=np.float32) / 255.0
        if args.mode == "pano":
            px_per_rad = (w // 2) / (2 * np.pi)
        else:
            px_per_rad = 0.5 * (w // 2) / np.tan(np.radians(args.hfov) / 2)
        band = int(np.ceil(px_per_rad * args.fill_lean * (1 / z.min() - 1 / z.max())))
        band = min(band, max(h, w) // 4)
        mask, bc, bz = background_layer(hrgb, hz, band, args.fill_jump)
        bxyz, bfoot, bdirs = backproject(bc, bz, args.mode, args.hfov)
        m = mask.reshape(-1)
        bxyz, bc_f = bxyz.reshape(-1, 3)[m], bc.reshape(-1, 3)[m]
        bfoot, bdirs = bfoot.reshape(-1, 2)[m], bdirs.reshape(-1, 3)[m]
        bscales = np.stack([bfoot[:, 0] * s, bfoot[:, 1] * s, np.minimum(bfoot[:, 0], bfoot[:, 1]) * 0.15], 1)
        xyz_f = np.concatenate([xyz_f, bxyz])
        rgb_f = np.concatenate([rgb_f, bc_f])
        scales = np.concatenate([scales, bscales])
        quats = np.concatenate([quats, quat_look(bdirs)])
        opacity = np.concatenate([opacity, np.full(len(bxyz), 0.97, dtype=np.float32)])
        n_bg = len(bxyz)
        print(f"      background layer: band {band}px @ half-res, {n_bg:,} hidden splats")

    return {"xyz": xyz_f, "rgb": rgb_f, "scales": np.maximum(scales, 1e-5), "quats": quats,
            "opacity": opacity, "z": z, "edges": edges, "n_fg": n_fg, "n_bg": n_bg}


# --------------------------------------------------------------------------- previews


def render_preview(xyz, rgb, eye, size, hfov_deg, yaw_deg=0.0) -> Image.Image:
    """Z-buffered point render from `eye` (OpenCV frame) - a cheap stand-in for the HMD."""
    w, h = size
    p = xyz - np.asarray(eye, dtype=np.float32)
    if yaw_deg:
        a = np.radians(yaw_deg)
        c, s = np.cos(a), np.sin(a)
        p = np.stack([c * p[:, 0] - s * p[:, 2], p[:, 1], s * p[:, 0] + c * p[:, 2]], 1)
    front = p[:, 2] > 0.05
    p, col = p[front], rgb[front]
    f = 0.5 * w / np.tan(np.radians(hfov_deg) / 2)
    u0 = (p[:, 0] / p[:, 2] * f + w / 2).astype(np.int64)
    v0 = (p[:, 1] / p[:, 2] * f + h / 2).astype(np.int64)
    # 2x2 px per point: covers magnification pinholes a real splat renderer wouldn't show.
    u = np.concatenate([u0, u0 + 1, u0, u0 + 1])
    v = np.concatenate([v0, v0, v0 + 1, v0 + 1])
    zz, col = np.tile(p[:, 2], 4), np.tile(col, (4, 1))
    ok = (u >= 0) & (u < w) & (v >= 0) & (v < h)
    u, v, zz, col = u[ok], v[ok], zz[ok], col[ok]
    order = np.argsort(zz)
    idx = (v * w + u)[order]
    _, first = np.unique(idx, return_index=True)
    img = np.zeros((h * w, 3), dtype=np.float32)
    img[:] = (1.0, 0.0, 1.0)  # magenta = disoccluded hole
    img[idx[first]] = col[order][first]
    return Image.fromarray((img.reshape(h, w, 3) * 255).astype(np.uint8))


def contact_sheet(tiles: list[tuple[str, Image.Image]], cols: int) -> Image.Image:
    from PIL import ImageDraw

    tw, th = tiles[0][1].size
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (tw * cols, (th + 22) * rows), (20, 20, 20))
    d = ImageDraw.Draw(sheet)
    for i, (label, im) in enumerate(tiles):
        x, y = (i % cols) * tw, (i // cols) * (th + 22)
        sheet.paste(im, (x, y + 22))
        d.text((x + 6, y + 4), label, fill=(240, 240, 240))
    return sheet


# --------------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="run directory under runs/")
    ap.add_argument("--prompt", help="txt2img prompt (z-image turbo)")
    ap.add_argument("--image", type=Path, help="use an existing image instead of generating")
    ap.add_argument("--mode", choices=["perspective", "pano"], default="perspective")
    ap.add_argument("--width", type=int, default=None)
    ap.add_argument("--height", type=int, default=None)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--hfov", type=float, default=70.0, help="horizontal FOV assumed for perspective art")
    ap.add_argument("--near", type=float, default=1.2, help="metres for the nearest depth value")
    ap.add_argument("--far", type=float, default=50.0, help="metres for the farthest depth value")
    ap.add_argument("--depth-mode", choices=["disparity", "linear"], default="linear",
                    help="Lotus-D predicts affine depth, so linear is the right default")
    ap.add_argument("--fill-lean", type=float, default=0.25,
                    help="metres of head movement the hidden background layer should cover (0 = off)")
    ap.add_argument("--fill-jump", type=float, default=1.5,
                    help="a surface must be this many times farther to count as background")
    ap.add_argument("--depth-smooth", type=int, default=3, help="3x3 box-blur passes over the depth map")
    ap.add_argument("--max-width", type=int, default=0,
                    help="downsample before splatting (1 splat/pixel); 0 = full resolution")
    ap.add_argument("--reuse", action="store_true", help="reuse source.png/depth.png already in the run dir")
    ap.add_argument("--flip-depth", action="store_true", help="if the depth map is near=dark")
    ap.add_argument("--edge-ratio", type=float, default=1.15)
    ap.add_argument("--drop-edges", action="store_true", help="drop discontinuity pixels (no rubber sheets)")
    ap.add_argument("--splat-scale", type=float, default=0.65)
    ap.add_argument("--comfy", default="http://127.0.0.1:6966")
    args = ap.parse_args()
    out = HERE / "runs" / args.name
    prev = out / "run.json"
    if args.reuse and prev.exists():
        old = json.loads(prev.read_text(encoding="utf-8"))
        args.prompt = args.prompt or old.get("prompt")
        args.seed = old.get("seed") if args.seed is None else args.seed
    if not args.prompt and not args.image and not args.reuse:
        ap.error("pass --prompt or --image")

    out.mkdir(parents=True, exist_ok=True)
    comfy = Comfy(args.comfy)
    timings: dict[str, float] = {}

    # 1. source art
    t0 = time.time()
    src_path = out / "source.png"
    reuse = args.reuse and src_path.exists() and (out / "depth.png").exists()
    if reuse:
        src = Image.open(src_path).convert("RGB")
    elif args.image:
        src = Image.open(args.image).convert("RGB")
    else:
        w = args.width or (2048 if args.mode == "pano" else 1344)
        h = args.height or (1024 if args.mode == "pano" else 768)
        seed = args.seed if args.seed is not None else random.randint(0, 2**48)
        args.seed = seed
        prompt = args.prompt
        if args.mode == "pano":
            prompt = ("360 degree equirectangular panorama, full spherical view, seamless wraparound, "
                      "level horizon at image center. " + prompt)
        imgs = comfy.run(zimage_turbo_workflow(prompt, w, h, seed))
        src = imgs[0].convert("RGB")
    if not reuse:
        src.save(src_path)
    timings["source_s"] = round(time.time() - t0, 2)
    print(f"[1/4] source {src.size} in {timings['source_s']}s{' (reused)' if reuse else ''}")

    # 2. depth
    t0 = time.time()
    if reuse:
        depth = Image.open(out / "depth.png")
    else:
        uploaded = comfy.upload(src_path)
        depth = comfy.run(lotus_depth_workflow(uploaded))[0]
        depth.save(out / "depth.png")
    timings["depth_s"] = round(time.time() - t0, 2)
    print(f"[2/4] depth {depth.size} in {timings['depth_s']}s")

    # 3. splats
    t0 = time.time()
    sp = build_splats(src, depth, args)
    ply = out / "scene.ply"
    write_ply(ply, sp["xyz"], sp["rgb"], sp["scales"], sp["quats"], sp["opacity"])
    timings["splat_s"] = round(time.time() - t0, 2)
    z = sp["z"]
    print(f"[3/4] {len(sp['xyz']):,} splats, {ply.stat().st_size / 2**20:.1f} MiB, "
          f"z {z.min():.2f}..{z.max():.2f} m, edges {sp['edges'].mean() * 100:.1f}%")

    # 4. previews (half-res, lean left/right, step forward; pano also turns)
    t0 = time.time()
    pw, ph = 672, 384
    xyz, rgb = sp["xyz"], sp["rgb"]
    tiles = [("source", src.resize((pw, ph)))]
    dm = Image.fromarray((np.clip(1 - (z - z.min()) / (np.ptp(z) + 1e-6), 0, 1) * 255).astype(np.uint8))
    tiles.append(("depth (white=near)", dm.convert("RGB").resize((pw, ph))))
    hfov = args.hfov if args.mode == "perspective" else 90.0
    for label, eye, yaw in [("center", (0, 0, 0), 0), ("lean L 10cm", (-0.10, 0, 0), 0),
                            ("lean R 10cm", (0.10, 0, 0), 0), ("lean L 20cm", (-0.20, 0, 0), 0),
                            ("lean R 20cm", (0.20, 0, 0), 0), ("step fwd 30cm", (0, 0, 0.30), 0)]:
        tiles.append((label, render_preview(xyz, rgb, eye, (pw, ph), hfov, yaw)))
    if args.mode == "pano":
        for yaw in (90, 180, 270):
            tiles.append((f"turn {yaw} deg", render_preview(xyz, rgb, (0, 0, 0), (pw, ph), hfov, yaw)))
    contact_sheet(tiles, 2).save(out / "previews.png")
    timings["preview_s"] = round(time.time() - t0, 2)
    print(f"[4/4] previews.png in {timings['preview_s']}s (magenta = disoccluded holes)")

    meta = {
        "name": args.name, "mode": args.mode, "prompt": args.prompt, "seed": args.seed,
        "input_sha256": hashlib.sha256(src_path.read_bytes()).hexdigest(),
        "settings": {k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items()},
        "splats": int(len(sp["xyz"])), "splats_fg": int(sp["n_fg"]), "splats_bg": int(sp["n_bg"]),
        "ply_bytes": ply.stat().st_size,
        "depth_range_m": [float(z.min()), float(z.max())], "timings": timings,
        "viewer": {"eye_height_m": 1.6},
    }
    (out / "run.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    runs = sorted(p.parent.name for p in (HERE / "runs").glob("*/scene.ply"))
    (HERE / "runs" / "index.json").write_text(json.dumps(runs), encoding="utf-8")
    print(f"done -> {out}")


if __name__ == "__main__":
    main()
