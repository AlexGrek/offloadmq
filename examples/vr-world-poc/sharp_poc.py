"""SHARP PoC: existing art -> Apple SHARP 3DGS -> runs/<name>/ for the same viewer.

Run with the SHARP venv's interpreter (built by `omq sharp install`), not `uv run`:

  ~/.offload-agent/sharp/.venv/Scripts/python.exe sharp_poc.py \
      --image C:/AI/output/foo.png --name foo-sharp [--image ... --name ...]

The model loads once for every --image/--name pair. Output per run matches
pipeline.py (source.png, scene.ply, previews.png, run.json) so index.html shows
Lotus and SHARP runs of the same picture side by side. scene.ply keeps only the
3DGS `vertex` element (SHARP also writes intrinsics/extrinsics/... elements).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
import requests
import torch
from PIL import Image
from plyfile import PlyData, PlyElement

from pipeline import contact_sheet, render_preview  # noqa: E402  (same dir)
from sharp.cli.predict import predict_image
from sharp.models import PredictorParams, create_predictor
from sharp.utils import io as sharp_io
from sharp.utils.gaussians import save_ply

HERE = Path(__file__).resolve().parent
CKPT = Path.home() / ".offload-agent" / "sharp" / "checkpoints" / "sharp_2572gikvuh.pt"
SH_C0 = 0.28209479177387814


def free_comfy(url: str) -> None:
    try:
        requests.post(f"{url}/free", json={"unload_models": True, "free_memory": True}, timeout=10)
        time.sleep(2)
    except requests.RequestException as e:
        print(f"  (ComfyUI /free failed: {e})")


def focal_px(img_path: Path, w: int, h: int, hfov: float | None) -> float:
    if hfov:
        return 0.5 * w / math.tan(math.radians(hfov) / 2)
    return float(sharp_io.load_rgb(img_path)[2])  # EXIF, else SHARP's 30 mm default


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", type=Path, action="append", required=True)
    ap.add_argument("--name", action="append", required=True)
    ap.add_argument("--hfov", type=float, default=None, help="override focal (default: EXIF / 30 mm)")
    ap.add_argument("--comfy", default="http://127.0.0.1:6966")
    ap.add_argument("--min-opacity", type=float, default=0.0, help="drop gaussians below this opacity")
    args = ap.parse_args()
    if len(args.image) != len(args.name):
        ap.error("--image and --name must pair up")

    free_comfy(args.comfy)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    t0 = time.time()
    model = create_predictor(PredictorParams())
    model.load_state_dict(torch.load(CKPT, weights_only=True))
    model.eval().to(dev)
    load_s = round(time.time() - t0, 2)
    print(f"model on {dev} in {load_s}s")

    for img_path, name in zip(args.image, args.name):
        out = HERE / "runs" / name
        out.mkdir(parents=True, exist_ok=True)
        src = Image.open(img_path).convert("RGB")
        src.save(out / "source.png")
        image = np.asarray(src)
        h, w = image.shape[:2]
        f = focal_px(img_path, w, h, args.hfov)
        hfov = math.degrees(2 * math.atan(0.5 * w / f))

        if dev.type == "cuda":
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
        t0 = time.time()
        g = predict_image(model, image, f, dev)
        if dev.type == "cuda":
            torch.cuda.synchronize()
        predict_s = round(time.time() - t0, 2)
        peak = torch.cuda.max_memory_allocated() / 2**30 if dev.type == "cuda" else 0.0

        t0 = time.time()
        raw = out / "sharp_raw.ply"
        save_ply(g, f, (h, w), raw)
        with raw.open("rb") as fh:  # no mmap: Windows can't unlink a mapped file
            v = PlyData.read(fh, mmap=False)["vertex"].data.copy()
        raw.unlink()
        opacity = 1 / (1 + np.exp(-v["opacity"]))
        keep = opacity >= args.min_opacity
        v = v[keep]
        PlyData([PlyElement.describe(v, "vertex")], text=False).write(str(out / "scene.ply"))
        save_s = round(time.time() - t0, 2)

        xyz = np.stack([v["x"], v["y"], v["z"]], 1)
        rgb = np.clip(np.stack([v["f_dc_0"], v["f_dc_1"], v["f_dc_2"]], 1) * SH_C0 + 0.5, 0, 1)
        scale = np.exp(np.stack([v["scale_0"], v["scale_1"], v["scale_2"]], 1))
        op = opacity[keep]
        z = xyz[:, 2]

        t0 = time.time()
        pw, ph = 672, round(672 * h / w)
        vis = op > 0.3  # point preview: ignore near-transparent gaussians
        tiles = [("source", src.resize((pw, ph)))]
        for label, eye in [("center", (0, 0, 0)), ("lean L 10cm", (-0.10, 0, 0)), ("lean R 10cm", (0.10, 0, 0)),
                           ("lean L 20cm", (-0.20, 0, 0)), ("lean R 20cm", (0.20, 0, 0)),
                           ("step fwd 30cm", (0, 0, 0.30))]:
            tiles.append((label, render_preview(xyz[vis], rgb[vis], eye, (pw, ph), hfov)))
        contact_sheet(tiles, 2).save(out / "previews.png")
        preview_s = round(time.time() - t0, 2)

        ply_bytes = (out / "scene.ply").stat().st_size
        meta = {
            "name": name, "mode": "perspective", "generator": "apple-sharp",
            "source_path": str(img_path), "input_sha256": hashlib.sha256(img_path.read_bytes()).hexdigest(),
            "settings": {"hfov": round(hfov, 1), "focal_px": round(f, 1), "min_opacity": args.min_opacity,
                         "source_size": [w, h]},
            "splats": int(len(v)), "splats_fg": int(len(v)), "splats_bg": 0, "ply_bytes": ply_bytes,
            "depth_range_m": [float(np.percentile(z, 1)), float(np.percentile(z, 99))],
            "stats": {
                "opacity_p10_p50_p90": [float(x) for x in np.percentile(op, [10, 50, 90])],
                "scale_max_p50_p99_m": [float(x) for x in np.percentile(scale.max(1), [50, 99])],
                "dropped_low_opacity": int((~keep).sum()),
            },
            "timings": {"model_load_s": load_s, "predict_s": predict_s, "save_s": save_s,
                        "preview_s": preview_s},
            "peak_vram_gib": round(peak, 2),
            "viewer": {"eye_height_m": 1.6},
        }
        (out / "run.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        print(f"{name}: {len(v):,} gaussians, {ply_bytes / 2**20:.1f} MiB, hfov {hfov:.0f} deg, "
              f"predict {predict_s}s, peak {peak:.1f} GiB, z p1..p99 "
              f"{meta['depth_range_m'][0]:.2f}..{meta['depth_range_m'][1]:.2f} m")

    runs = sorted(p.parent.name for p in (HERE / "runs").glob("*/scene.ply"))
    (HERE / "runs" / "index.json").write_text(json.dumps(runs), encoding="utf-8")


if __name__ == "__main__":
    main()
