"""WorldGen `use_sharp` path: a 360 panorama -> Apple SHARP Gaussians per cube face.

Mirrors WorldGen's pano_sharp.predict_equirectangular (ZiYang-xie/WorldGen @ 7ce7b27):
six 90-degree cube faces go through SHARP one by one, each face's Gaussians are scaled
so their median depth matches the panorama depth map (WorldGen: DA-2, here: the Lotus
depth.png worldgen_poc.py already wrote), rotated into the panorama frame and merged.

Run with the SHARP venv's interpreter after worldgen_poc.py produced runs/<name>/:

  ~/.offload-agent/sharp/.venv/Scripts/python.exe pano_sharp_poc.py --name market-wg3

Writes runs/<name>-sharp360/ with scene.ply, previews.png and run.json, so index.html
lists it next to the Lotus splat of the same panorama.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import requests
import torch
from PIL import Image

from pipeline import contact_sheet, render_preview  # noqa: E402  (same dir)
from sharp.cli.predict import predict_image
from sharp.models import PredictorParams, create_predictor
from sharp.utils import color_space
from sharp.utils.gaussians import convert_rgb_to_spherical_harmonics

HERE = Path(__file__).resolve().parent
CKPT = Path.home() / ".offload-agent" / "sharp" / "checkpoints" / "sharp_2572gikvuh.pt"
SH_C0 = 0.28209479177387814
FIELDS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
          "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]

# (name, forward, image-down) in the OpenCV panorama frame (x right, y down, z forward).
FACES = [
    ("front", (0, 0, 1), (0, 1, 0)), ("right", (1, 0, 0), (0, 1, 0)),
    ("back", (0, 0, -1), (0, 1, 0)), ("left", (-1, 0, 0), (0, 1, 0)),
    ("up", (0, -1, 0), (0, 0, 1)), ("down", (0, 1, 0), (0, 0, -1)),
]


def face_basis(fwd, down) -> np.ndarray:
    f, d = np.asarray(fwd, float), np.asarray(down, float)
    r = np.cross(d, f)  # OpenCV: x = y cross z
    return np.stack([r, d, f], 1)  # columns = camera axes in world -> world_from_cam


def sample_equirect(img: np.ndarray, rays: np.ndarray) -> np.ndarray:
    """Bilinear lookup with horizontal wrap; img HxWxC, rays ...x3 (unit)."""
    h, w = img.shape[:2]
    lon = np.arctan2(rays[..., 0], rays[..., 2])
    lat = np.arcsin(np.clip(-rays[..., 1], -1, 1))
    u = (lon / (2 * np.pi) + 0.5) * w - 0.5
    v = np.clip((0.5 - lat / np.pi) * h - 0.5, 0, h - 1.001)
    u0, v0 = np.floor(u).astype(np.int64), v.astype(np.int64)
    fu, fv = (u - u0)[..., None], (v - v0)[..., None]
    a, b = img[v0, u0 % w], img[v0, (u0 + 1) % w]
    c, d = img[v0 + 1, u0 % w], img[v0 + 1, (u0 + 1) % w]
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv


def face_rays(size: int, basis: np.ndarray) -> np.ndarray:
    t = (np.arange(size) + 0.5) / size * 2 - 1
    x, y = np.meshgrid(t, t)
    rays = np.stack([x, y, np.ones_like(x)], -1) @ basis.T
    return rays / np.linalg.norm(rays, axis=-1, keepdims=True)


def mat_to_quat(m: np.ndarray) -> np.ndarray:
    """wxyz quaternion of a proper rotation matrix."""
    w = math.sqrt(max(0.0, 1 + m[0, 0] + m[1, 1] + m[2, 2])) / 2
    x = math.sqrt(max(0.0, 1 + m[0, 0] - m[1, 1] - m[2, 2])) / 2
    y = math.sqrt(max(0.0, 1 - m[0, 0] + m[1, 1] - m[2, 2])) / 2
    z = math.sqrt(max(0.0, 1 - m[0, 0] - m[1, 1] + m[2, 2])) / 2
    x = math.copysign(x, m[2, 1] - m[1, 2])
    y = math.copysign(y, m[0, 2] - m[2, 0])
    z = math.copysign(z, m[1, 0] - m[0, 1])
    return np.array([w, x, y, z])


def quat_mul(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    aw, ax, ay, az = a.unbind(-1)
    bw, bx, by, bz = b.unbind(-1)
    return torch.stack([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
                        aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw], -1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True, help="worldgen_poc.py run with pano.png + depth.png")
    ap.add_argument("--face", type=int, default=768, help="cube face size fed to SHARP (upscaled to 1536)")
    ap.add_argument("--keep", type=float, default=0.35, help="random fraction of Gaussians kept (PLY budget)")
    ap.add_argument("--min-opacity", type=float, default=0.05)
    ap.add_argument("--near", type=float, default=1.2)
    ap.add_argument("--far", type=float, default=50.0)
    ap.add_argument("--comfy", default="http://127.0.0.1:6966")
    a = ap.parse_args()

    src_dir = HERE / "runs" / a.name
    out = HERE / "runs" / f"{a.name}-sharp360"
    out.mkdir(parents=True, exist_ok=True)
    pano = np.asarray(Image.open(src_dir / "pano.png").convert("RGB"), np.float32) / 255.0
    dmap = Image.open(src_dir / "depth.png").convert("L").resize((pano.shape[1], pano.shape[0]), Image.BICUBIC)
    dist = a.near + (1 - np.asarray(dmap, np.float32) / 255.0) * (a.far - a.near)
    Image.fromarray((pano * 255).astype(np.uint8)).save(out / "source.png")

    try:
        requests.post(f"{a.comfy}/free", json={"unload_models": True, "free_memory": True}, timeout=10)
        time.sleep(2)
    except requests.RequestException as e:
        print(f"(ComfyUI /free failed: {e})")

    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    t0 = time.time()
    model = create_predictor(PredictorParams())
    model.load_state_dict(torch.load(CKPT, weights_only=True))
    model.eval().to(dev)
    timings = {"model_load_s": round(time.time() - t0, 2)}
    if dev.type == "cuda":
        torch.cuda.reset_peak_memory_stats()

    gen = torch.Generator(device="cpu").manual_seed(0)
    parts, per_face = [], {}
    t0 = time.time()
    for name, fwd, down in FACES:
        basis = face_basis(fwd, down)
        rays = face_rays(a.face, basis)
        face_rgb = (sample_equirect(pano, rays) * 255).round().clip(0, 255).astype(np.uint8)
        face_z = sample_equirect(dist[..., None], rays)[..., 0] * (rays @ np.asarray(fwd, float))
        Image.fromarray(face_rgb).save(out / f"face_{name}.png")

        g = predict_image(model, face_rgb, a.face / 2.0, dev)  # 90 deg face: f = size / 2
        mean = g.mean_vectors[0]
        z = mean[:, 2]
        scale = float(np.median(face_z)) / float(z[z > 0.01].median())
        rot = torch.tensor(basis, dtype=torch.float32, device=dev)
        q_face = torch.tensor(mat_to_quat(basis), dtype=torch.float32, device=dev)

        op = g.opacities[0]
        keep = (op >= a.min_opacity) & (torch.rand(op.shape, generator=gen).to(dev) < a.keep)
        xyz = (mean[keep] * scale) @ rot.T
        quats = quat_mul(q_face.expand(int(keep.sum()), 4), g.quaternions[0][keep])
        cols = torch.cat((
            xyz,
            convert_rgb_to_spherical_harmonics(color_space.linearRGB2sRGB(g.colors[0][keep])),
            torch.logit(op[keep].clamp(1e-6, 1 - 1e-6)).unsqueeze(-1),
            torch.log(g.singular_values[0][keep] * scale),
            quats,
        ), 1).float().cpu().numpy()
        parts.append(cols)
        per_face[name] = {"scale": round(scale, 3), "kept": int(len(cols)), "total": int(len(op))}
        print(f"  {name:5s}: scale x{scale:.2f}, kept {len(cols):,}/{len(op):,}")
    if dev.type == "cuda":
        torch.cuda.synchronize()
    timings["predict_s"] = round(time.time() - t0, 2)
    peak = torch.cuda.max_memory_allocated() / 2**30 if dev.type == "cuda" else 0.0

    data = np.ascontiguousarray(np.concatenate(parts).astype("<f4"))
    header = "\n".join(["ply", "format binary_little_endian 1.0", f"element vertex {len(data)}"]
                       + [f"property float {f}" for f in FIELDS] + ["end_header", ""])
    ply = out / "scene.ply"
    with ply.open("wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(data.tobytes())

    t0 = time.time()
    xyz = data[:, 0:3]
    rgb = np.clip(data[:, 3:6] * SH_C0 + 0.5, 0, 1)
    vis = 1 / (1 + np.exp(-data[:, 6])) > 0.3
    pw, ph = 672, 384
    tiles = [("panorama", Image.fromarray((pano * 255).astype(np.uint8)).resize((pw, ph)))]
    tiles.append(("cube faces F/R/B/L", Image.fromarray(np.concatenate(
        [np.asarray(Image.open(out / f"face_{n}.png").resize((ph // 2, ph // 2))) for n in
         ("front", "right", "back", "left")], 1)).resize((pw, ph // 2 * pw // (ph * 2)))))
    for label, eye, yaw in [("center", (0, 0, 0), 0), ("lean R 20cm", (0.20, 0, 0), 0),
                            ("step fwd 30cm", (0, 0, 0.30), 0), ("turn 90", (0, 0, 0), 90),
                            ("turn 180", (0, 0, 0), 180), ("turn 45 (face edge)", (0, 0, 0), 45)]:
        im = render_preview(xyz[vis], rgb[vis], eye, (pw // 2, ph // 2), 90.0, yaw)
        tiles.append((label, im.resize((pw, ph), Image.NEAREST)))
    contact_sheet(tiles, 2).save(out / "previews.png")
    timings["preview_s"] = round(time.time() - t0, 2)

    z = np.linalg.norm(xyz, axis=1)
    meta = {
        "name": out.name, "mode": "pano", "generator": "worldgen-pano-sharp-poc", "source_run": a.name,
        "settings": vars(a), "faces": per_face, "splats": int(len(data)), "splats_fg": int(len(data)),
        "splats_bg": 0, "ply_bytes": ply.stat().st_size,
        "depth_range_m": [float(np.percentile(z, 1)), float(np.percentile(z, 99))],
        "timings": timings, "peak_vram_gib": round(peak, 2), "viewer": {"eye_height_m": 1.6},
    }
    (out / "run.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    runs = sorted(p.parent.name for p in (HERE / "runs").glob("*/scene.ply"))
    (HERE / "runs" / "index.json").write_text(json.dumps(runs), encoding="utf-8")
    print(f"done -> {out}: {len(data):,} gaussians, {ply.stat().st_size / 2**20:.1f} MiB, "
          f"peak {peak:.1f} GiB, timings {timings}")


if __name__ == "__main__":
    main()
