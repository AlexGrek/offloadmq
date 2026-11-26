"""Plan A1 (docs/worlds-quality-plan.md): WorldMirror 2.0 alone on a single picture.

A feed-forward baseline against SHARP: does WorldMirror's geometry and Gaussians match
SHARP inside the frame? Each test scene reads the *same* source.png as its
runs/<scene>-sharp run and writes runs/<scene>-wm/:

  gaussians.ply   the official pipeline's output, untouched
  scene.ply       the same splats for the PoC viewer: camera-0 frame, scaled to
                  SHARP's metric depth, opacity re-encoded as a standard 3DGS logit
  source.png, previews.png, run.json

Run with the private venv's interpreter (see README "WorldMirror 2.0"), not `uv run`:

  E:/hyworld-poc/venv/Scripts/python.exe worldmirror_poc.py            # all five scenes
  E:/hyworld-poc/venv/Scripts/python.exe worldmirror_poc.py --scene torii --no-sky-mask --suffix wm-sky

Tencent HY-World 2.0 is under its Community License: not licensed in the EU, UK or
South Korea (code, weights *and outputs*). Nothing of it is vendored here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
import types
from pathlib import Path

import numpy as np
import requests
import torch
import torch.nn.functional as F
from PIL import Image
from plyfile import PlyData

from pipeline import contact_sheet, render_preview  # noqa: E402  (same dir)

HERE = Path(__file__).resolve().parent
SCENES = ["torii", "temple", "courtyard-01", "market", "forest"]
SH_C0 = 0.28209479177387814
FIELDS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
          "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


# --------------------------------------------------------------------------- model


def install_flash_attn_shim() -> None:
    """WorldMirror hard-imports FlashAttention, which has no practical Windows build.
    Provide the one function it uses on top of torch's own SDPA (which has a flash
    kernel); inputs are [batch, tokens, heads, head_dim]."""

    def flash_attn_func(q, k, v, dropout_p: float = 0.0, **_):
        return F.scaled_dot_product_attention(
            q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), dropout_p=dropout_p
        ).transpose(1, 2)

    mod = types.ModuleType("flash_attn_interface")
    mod.flash_attn_func = flash_attn_func
    sys.modules["flash_attn_interface"] = mod


def git_revision(path: Path) -> str:
    try:
        return subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], capture_output=True,
                              text=True, timeout=10, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def free_comfy(url: str) -> None:
    try:
        requests.post(f"{url}/free", json={"unload_models": True, "free_memory": True}, timeout=10)
        time.sleep(2)
    except requests.RequestException as e:
        print(f"(ComfyUI /free failed: {e})")


# --------------------------------------------------------------------------- geometry


def quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    aw, ax, ay, az = np.moveaxis(a, -1, 0)
    bw, bx, by, bz = np.moveaxis(b, -1, 0)
    return np.stack([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw], -1)


def mat_to_quat(m: np.ndarray) -> np.ndarray:
    """wxyz quaternion of a proper rotation matrix."""
    w = math.sqrt(max(0.0, 1 + m[0, 0] + m[1, 1] + m[2, 2])) / 2
    x = math.copysign(math.sqrt(max(0.0, 1 + m[0, 0] - m[1, 1] - m[2, 2])) / 2, m[2, 1] - m[1, 2])
    y = math.copysign(math.sqrt(max(0.0, 1 - m[0, 0] + m[1, 1] - m[2, 2])) / 2, m[0, 2] - m[2, 0])
    z = math.copysign(math.sqrt(max(0.0, 1 - m[0, 0] - m[1, 1] + m[2, 2])) / 2, m[1, 0] - m[0, 1])
    return np.array([w, x, y, z])


def front_depth(xyz: np.ndarray, opacity: np.ndarray, fx: float, fy: float, cx: float, cy: float,
                w: float, h: float, grid: int = 96) -> np.ndarray:
    """Near-surface depth per image cell (20th percentile of opaque splats), NaN if empty.
    Cells are in normalised image coordinates, so two resolutions compare directly."""
    z = xyz[:, 2]
    ok = (z > 0.05) & (opacity > 0.5)
    x, y, z = xyz[ok, 0], xyz[ok, 1], z[ok]
    u = ((fx * x / z + cx) / w * grid).astype(np.int64)
    v = ((fy * y / z + cy) / h * grid).astype(np.int64)
    inside = (u >= 0) & (u < grid) & (v >= 0) & (v < grid)
    cell, z = (v * grid + u)[inside], z[inside]
    order = np.lexsort((z, cell))
    cell, z = cell[order], z[order]
    ids, start, count = np.unique(cell, return_index=True, return_counts=True)
    out = np.full(grid * grid, np.nan)
    out[ids] = z[start + (count - 1) // 5]
    return out.reshape(grid, grid)


def compare_depth(ref: np.ndarray, test: np.ndarray) -> dict:
    """Scale that maps `test` onto `ref`, and how well the shapes agree afterwards."""
    both = np.isfinite(ref) & np.isfinite(test)
    ratio = ref[both] / test[both]
    scale = float(np.median(ratio))
    err = np.abs(np.log(ratio / scale))
    return {
        "scale_to_sharp": scale,
        "cells_compared": int(both.sum()),
        "median_rel_error": float(np.expm1(np.median(err))),
        "p90_rel_error": float(np.expm1(np.percentile(err, 90))),
        "within_10pct": float((err < math.log(1.10)).mean()),
        "log_depth_correlation": float(np.corrcoef(np.log(ref[both]), np.log(test[both]))[0, 1]),
    }


def read_sharp(run: Path) -> tuple[np.ndarray, np.ndarray, dict]:
    v = PlyData.read(str(run / "scene.ply"), mmap=False)["vertex"].data
    xyz = np.stack([v["x"], v["y"], v["z"]], 1)
    opacity = 1 / (1 + np.exp(-v["opacity"]))
    return xyz, opacity, json.loads((run / "run.json").read_text(encoding="utf-8"))


def convert(official: Path, c2w: np.ndarray) -> tuple[dict, dict]:
    """Official gaussians.ply -> arrays in camera-0's frame (OpenCV), unscaled.

    The official writer stores opacity as a probability; standard 3DGS viewers expect
    the logit and would apply the sigmoid a second time."""
    v = PlyData.read(str(official), mmap=False)["vertex"].data
    raw_opacity = np.asarray(v["opacity"], np.float64)
    encoding = "probability" if raw_opacity.min() >= 0 and raw_opacity.max() <= 1 else "logit"
    opacity = raw_opacity if encoding == "probability" else 1 / (1 + np.exp(-raw_opacity))
    w2c = np.linalg.inv(c2w)
    xyz = np.stack([v["x"], v["y"], v["z"]], 1) @ w2c[:3, :3].T + w2c[:3, 3]
    quats = np.stack([v[f"rot_{i}"] for i in range(4)], 1)
    quats = quat_mul(np.broadcast_to(mat_to_quat(w2c[:3, :3]), quats.shape), quats)
    splats = {
        "xyz": xyz, "opacity": opacity, "quats": quats,
        "sh": np.stack([v[f"f_dc_{i}"] for i in range(3)], 1),
        "log_scale": np.stack([v[f"scale_{i}"] for i in range(3)], 1),
    }
    info = {"official_opacity_encoding": encoding,
            "camera0_translation": [float(t) for t in c2w[:3, 3]],
            "camera0_rotation_deg": float(np.degrees(np.arccos(np.clip((np.trace(c2w[:3, :3]) - 1) / 2, -1, 1))))}
    return splats, info


def write_scene(path: Path, s: dict, scale: float) -> None:
    op = np.clip(s["opacity"], 1e-6, 1 - 1e-6)
    cols = np.concatenate([s["xyz"] * scale, s["sh"], np.log(op / (1 - op))[:, None],
                           s["log_scale"] + math.log(scale), s["quats"]], 1)
    data = np.ascontiguousarray(cols.astype("<f4"))
    header = "\n".join(["ply", "format binary_little_endian 1.0", f"element vertex {len(data)}"]
                       + [f"property float {f}" for f in FIELDS] + ["end_header", ""])
    with path.open("wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(data.tobytes())


def previews(path: Path, src: Image.Image, s: dict, scale: float, hfov: float) -> None:
    vis = s["opacity"] > 0.3
    xyz = (s["xyz"][vis] * scale).astype(np.float32)
    rgb = np.clip(s["sh"][vis] * SH_C0 + 0.5, 0, 1).astype(np.float32)
    pw, ph = 672, round(672 * src.height / src.width)
    tiles = [("source", src.resize((pw, ph)))]
    for label, eye in [("center", (0, 0, 0)), ("lean L 20cm", (-0.2, 0, 0)), ("lean R 40cm", (0.4, 0, 0)),
                       ("step fwd 1m", (0, 0, 1.0))]:
        tiles.append((label, render_preview(xyz, rgb, eye, (pw // 2, ph // 2), hfov).resize((pw, ph), Image.NEAREST)))
    contact_sheet(tiles, 3).save(path)


# --------------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scene", action="append", help=f"test scene (default: {', '.join(SCENES)})")
    ap.add_argument("--suffix", default="wm", help="run directory suffix: runs/<scene>-<suffix>")
    ap.add_argument("--work", type=Path, default=Path("E:/hyworld-poc"), help="holds src/, weights/, venv/")
    ap.add_argument("--target-size", type=int, default=952, help="longest edge fed to the model (official 952)")
    ap.add_argument("--no-sky-mask", action="store_true", help="keep sky Gaussians (official default removes them)")
    ap.add_argument("--no-edge-mask", action="store_true")
    ap.add_argument("--no-voxel-prune", action="store_true",
                    help="keep every masked per-pixel Gaussian (official default merges 0.002-unit voxels)")
    ap.add_argument("--comfy", default="http://127.0.0.1:6966")
    a = ap.parse_args()
    scenes = a.scene or SCENES
    for scene in scenes:
        if not (HERE / "runs" / f"{scene}-sharp" / "source.png").exists():
            ap.error(f"runs/{scene}-sharp/source.png missing (the SHARP run provides the input)")

    src_repo = a.work / "src"
    weights = a.work / "weights"
    sys.path.insert(0, str(src_repo))
    os.chdir(a.work)  # the official sky mask downloads skyseg.onnx into the cwd
    install_flash_attn_shim()
    from hyworld2.worldrecon.hyworldmirror.utils import inference_utils
    from hyworld2.worldrecon.pipeline import WorldMirrorPipeline

    if a.no_voxel_prune:
        # The official merge (and the model's own training renderer, `prune_gs`) uses the
        # confidence weight as opacity; the raw opacity head (median ~0.18) is effectively
        # unused, so an unmerged splat must take its weight too.
        inference_utils._voxel_prune_gaussians = lambda means, scales, quats, colors, opacities, weights: (
            means, scales, quats, colors, weights)

    free_comfy(a.comfy)
    t0 = time.time()
    pipe = WorldMirrorPipeline.from_pretrained(str(weights))
    load_s = round(time.time() - t0, 2)
    revision = git_revision(src_repo)

    # The first forward pass pays CUDA kernel start-up; keep it out of the timings.
    warm = HERE / "runs" / f"{scenes[0]}-{a.suffix}"
    t0 = time.time()
    pipe(str(HERE / "runs" / f"{scenes[0]}-sharp" / "source.png"), strict_output_path=str(warm / "_warmup"),
         target_size=a.target_size, save_depth=False, save_normal=False, save_points=False, save_gs=False,
         apply_sky_mask=False, apply_edge_mask=False)
    warmup_s = round(time.time() - t0, 2)
    shutil.rmtree(warm / "_warmup", ignore_errors=True)

    summary = []
    for scene in scenes:
        sharp_run = HERE / "runs" / f"{scene}-sharp"
        out = HERE / "runs" / f"{scene}-{a.suffix}"
        out.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(sharp_run / "source.png", out / "source.png")
        src = Image.open(out / "source.png").convert("RGB")

        torch.cuda.reset_peak_memory_stats()
        t0 = time.time()
        pipe(str(out / "source.png"), strict_output_path=str(out / "official"), target_size=a.target_size,
             save_normal=False, save_points=False, apply_sky_mask=not a.no_sky_mask,
             apply_edge_mask=not a.no_edge_mask)
        torch.cuda.synchronize()
        pipeline_s = round(time.time() - t0, 2)
        peak = torch.cuda.max_memory_allocated() / 2**30
        official = out / "official"
        stages = {}
        for f in official.glob("*tim*.json"):
            stages = json.loads(f.read_text(encoding="utf-8"))
        shutil.move(official / "gaussians.ply", out / "gaussians.ply")

        cam = json.loads((official / "camera_params.json").read_text(encoding="utf-8"))
        c2w = np.array(cam["extrinsics"][0]["matrix"])
        K = np.array(cam["intrinsics"][0]["matrix"])
        # K is in processed-image pixels; the principal point sits at its centre.
        pw, ph = 2 * K[0, 2], 2 * K[1, 2]
        hfov = math.degrees(2 * math.atan(0.5 * pw / K[0, 0]))
        vfov = math.degrees(2 * math.atan(0.5 * ph / K[1, 1]))

        splats, info = convert(out / "gaussians.ply", c2w)
        sx, sop, smeta = read_sharp(sharp_run)
        sw, sh = smeta["settings"]["source_size"]
        sf = smeta["settings"]["focal_px"]
        geometry = compare_depth(
            front_depth(sx, sop, sf, sf, sw / 2, sh / 2, sw, sh),
            front_depth(splats["xyz"], splats["opacity"], K[0, 0], K[1, 1], K[0, 2], K[1, 2], pw, ph))
        scale = geometry["scale_to_sharp"]

        write_scene(out / "scene.ply", splats, scale)
        previews(out / "previews.png", src, splats, scale, hfov)

        z = splats["xyz"][:, 2] * scale
        meta = {
            "name": out.name, "mode": "perspective", "generator": "hy-worldmirror-2.0",
            "revision": {"code": revision, "weights": "tencent/HY-World-2.0 HY-WorldMirror-2.0"},
            "source_run": sharp_run.name,
            "input_sha256": hashlib.sha256((out / "source.png").read_bytes()).hexdigest(),
            "settings": {"hfov": round(hfov, 1), "vfov": round(vfov, 1), "target_size": a.target_size,
                         "processed_size": [int(pw), int(ph)], "sky_mask": not a.no_sky_mask,
                         "edge_mask": not a.no_edge_mask, "voxel_prune": not a.no_voxel_prune,
                         "source_size": list(src.size)},
            "sharp": {"hfov": smeta["settings"]["hfov"], "splats": smeta["splats"], "ply_bytes": smeta["ply_bytes"]},
            "geometry_vs_sharp": geometry, "ply_checks": info,
            "splats": int(len(z)), "splats_fg": int(len(z)), "splats_bg": 0,
            "ply_bytes": (out / "scene.ply").stat().st_size,
            "official_ply_bytes": (out / "gaussians.ply").stat().st_size,
            "depth_range_m": [float(np.percentile(z, 1)), float(np.percentile(z, 99))],
            "timings": {"model_load_s": load_s, "warmup_s": warmup_s, "pipeline_s": pipeline_s, "stages": stages},
            "peak_vram_gib": round(peak, 2), "torch": torch.__version__, "viewer": {"eye_height_m": 1.6},
        }
        (out / "run.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        summary.append(meta)

    runs = sorted(p.parent.name for p in (HERE / "runs").glob("*/scene.ply"))
    (HERE / "runs" / "index.json").write_text(json.dumps(runs), encoding="utf-8")
    print(f"\nmodel load {load_s}s, warmup {warmup_s}s")
    for m in summary:
        g = m["geometry_vs_sharp"]
        print(f"{m['name']:22s} {m['splats']:>9,} splats {m['ply_bytes'] / 2**20:6.1f} MiB  "
              f"{m['timings']['pipeline_s']:5.1f}s  {m['peak_vram_gib']:5.2f} GiB  "
              f"hfov {m['settings']['hfov']:.0f} (SHARP {m['sharp']['hfov']:.0f})  x{g['scale_to_sharp']:.2f}  "
              f"depth err {g['median_rel_error'] * 100:.1f}% (p90 {g['p90_rel_error'] * 100:.0f}%)  "
              f"corr {g['log_depth_correlation']:.3f}")


if __name__ == "__main__":
    main()
