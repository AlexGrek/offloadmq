"""Plan B, phase B0: render a SHARP scene from offset head poses and build hole masks.

No generation yet. Per scene: predict S0 with SHARP, check the renderer reproduces the
picture from the origin, measure how SHARP's two layers differ, then render every pose
and mark what the picture never showed:

* **hole** — nothing is drawn (accumulated alpha < 0.5);
* **unseen** — something is drawn, but that 3D point is not on any surface visible from
  the origin: it is behind a foreground object, stretched between two depths, or outside
  the original frame.

Writes colour and mask images, a contact sheet and mask fractions per pose. See
docs/worlds-fill-plan.md. Run with the SHARP venv's interpreter:

  E:/offload-agent/sharp/.venv/Scripts/python.exe sharp_fill_poc.py torii temple ...

Scene names are runs/<name>-sharp/ (source.png + run.json give the picture and focal).
Output: runs/_fill/<name>/ and runs/_fill/b0.json.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

from gpu_guard import require_memory

require_memory()  # before torch: loading it with CUDA takes several GiB of commit

import numpy as np  # noqa: E402
import requests  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from sharp.cli.predict import predict_image  # noqa: E402
from sharp.models import PredictorParams, create_predictor  # noqa: E402
from sharp.utils import color_space as cs_utils  # noqa: E402

import torch_splat as ts  # noqa: E402

HERE = Path(__file__).resolve().parent
CKPT = Path("E:/offload-agent/sharp/checkpoints/sharp_2572gikvuh.pt")
OUT = HERE / "runs" / "_fill"
LONG_SIDE = 1536
HOLE_ALPHA = 0.5
#: A point counts as seen if its depth is within this fraction of a nearby origin-view depth.
DEPTH_TOL = 0.05
#: Neighbourhood (px at 1536 on the long side) searched for that depth.
MATCH_WINDOW = 5
#: Specks narrower than this radius are dropped, then the mask grows by the dilation.
OPEN_PX = 1
DILATE_PX = 8

# label, position (OpenCV base frame: x right, y down, z forward), yaw left deg, preset
POSES: list[tuple[str, tuple[float, float, float], float, str]] = [
    ("centre", (0, 0, 0), 0, "-"),
    ("lean L 30cm", (-0.30, 0, 0), 0, "lean"),
    ("lean R 30cm", (0.30, 0, 0), 0, "lean"),
    ("lean up 15cm", (0, -0.15, 0), 0, "lean"),
    ("step fwd 60cm", (0, 0, 0.60), 0, "room"),
    ("yaw L 30", (0, 0, 0), 30, "room"),
    ("yaw R 30", (0, 0, 0), -30, "room"),
    ("yaw L 60", (0, 0, 0), 60, "wide"),
    ("yaw R 60", (0, 0, 0), -60, "wide"),
    ("strafe L 1m", (-1.0, 0, 0), 0, "wide"),
    ("strafe R 1m", (1.0, 0, 0), 0, "wide"),
]


def free_comfy(url: str = "http://127.0.0.1:6966") -> None:
    try:
        requests.post(f"{url}/free", json={"unload_models": True, "free_memory": True}, timeout=10)
        time.sleep(2)
    except requests.RequestException:
        pass


def to_img(x: torch.Tensor) -> Image.Image:
    a = x.detach().float().cpu().numpy()
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, -1)
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


def psnr(a: torch.Tensor, b: torch.Tensor) -> float:
    mse = float(((a - b) ** 2).mean())
    return 10 * math.log10(1 / max(mse, 1e-12))


def dilate(mask: torch.Tensor, px: int) -> torch.Tensor:
    if px <= 0:
        return mask
    return F.max_pool2d(mask[None, None].float(), 2 * px + 1, 1, px)[0, 0] > 0


def open_mask(mask: torch.Tensor, px: int) -> torch.Tensor:
    """Erode then dilate: drops specks without shrinking larger regions."""
    return dilate(~dilate(~mask, px), px)


class Visibility:
    """Which points of another view the origin camera saw, from its median depth map."""

    def __init__(self, origin: ts.Render, cam: ts.Camera, tol: float, window: int) -> None:
        self.cam, self.limit = cam, math.log1p(tol)
        log_d = torch.log(torch.nan_to_num(origin.median_depth, nan=1e9).clamp_min(1e-6))
        pad = window // 2
        padded = F.pad(log_d[None, None], (pad, pad, pad, pad), mode="replicate")
        self.near = F.unfold(padded, window)[0]  # (window², H·W)

    def unseen(self, r: ts.Render, cam: ts.Camera) -> torch.Tensor:
        H, W = r.alpha.shape
        drawn = torch.isfinite(r.median_depth) & (r.alpha >= HOLE_ALPHA)
        v, u = drawn.nonzero(as_tuple=True)
        z = r.median_depth[v, u]
        local = torch.stack([(u + 0.5 - cam.cx) / cam.fx * z, (v + 0.5 - cam.cy) / cam.fy * z, z], 1)
        p = (local - cam.t) @ cam.R  # back to the base frame (= the origin camera)
        o = self.cam
        z0 = p[:, 2].clamp_min(1e-6)
        u0 = torch.floor(o.fx * p[:, 0] / z0 + o.cx).long()
        v0 = torch.floor(o.fy * p[:, 1] / z0 + o.cy).long()
        inside = (p[:, 2] > 0) & (u0 >= 0) & (u0 < W) & (v0 >= 0) & (v0 < H)
        bad = ~inside
        idx = v0[inside] * W + u0[inside]
        logz = torch.log(z0[inside])
        gap = torch.full_like(logz, float("inf"))
        for row in self.near:  # one window offset at a time keeps memory flat
            gap = torch.minimum(gap, (row[idx] - logz).abs())
        bad[inside] = gap > self.limit
        out = torch.zeros_like(drawn)
        out[v, u] = bad
        return out


def overlay(color: torch.Tensor, unseen: torch.Tensor, hole: torch.Tensor) -> torch.Tensor:
    """Holes magenta, unseen surfaces cyan."""
    out = color.clone()
    out[unseen] = out[unseen] * 0.3 + torch.tensor([0.0, 0.9, 0.9], device=out.device) * 0.7
    out[hole] = torch.tensor([0.9, 0.0, 0.9], device=out.device)
    return out


def sheet(rows: list[tuple[str, list[Image.Image]]], tile_w: int, path: Path, per_row: int = 2) -> None:
    """Labelled groups of tiles, ``per_row`` groups side by side."""
    th = rows[0][1][0].height * tile_w // rows[0][1][0].width
    group_w = tile_w * len(rows[0][1]) + 8
    pad = 18
    lines = math.ceil(len(rows) / per_row)
    canvas = Image.new("RGB", (per_row * group_w, lines * (th + pad)), (20, 20, 20))
    d = ImageDraw.Draw(canvas)
    for i, (label, tiles) in enumerate(rows):
        x, y = (i % per_row) * group_w, (i // per_row) * (th + pad)
        d.text((x + 4, y + 3), label, fill=(230, 230, 230))
        for c, t in enumerate(tiles):
            canvas.paste(t.resize((tile_w, th)), (x + c * tile_w, y + pad))
    canvas.save(path)


def predict(model: torch.nn.Module, image: np.ndarray, f: float, dev: torch.device) -> tuple[ts.Gaussians, torch.Tensor, int]:
    g = predict_image(model, image, f, dev)
    n = g.mean_vectors.shape[1]
    grid = int(round(math.sqrt(n / 2)))
    assert 2 * grid * grid == n, f"unexpected SHARP layout: {n} Gaussians"
    layer = torch.arange(n, device=dev) // (grid * grid)
    colors = cs_utils.linearRGB2sRGB(g.colors[0]).clamp(0, 1)  # what exported PLYs (and Spark) show
    return ts.Gaussians(g.mean_vectors[0].float(), g.singular_values[0].float(), g.quaternions[0].float(),
                        colors.float(), g.opacities[0].float()), layer, grid


def layer_report(g: ts.Gaussians, layer: torch.Tensor, cam: ts.Camera, ref: torch.Tensor, out: Path) -> dict:
    """How SHARP's two layers differ, rendered alone from the origin."""
    renders = [ts.render(g.subset(layer == k), cam) for k in (0, 1)]
    report: dict = {}
    for k, r in enumerate(renders):
        report[str(k)] = {"coverage": round(float((r.alpha >= HOLE_ALPHA).float().mean()), 4),
                          "psnr_alone_db": round(psnr(r.color, ref), 2)}
        to_img(r.color).save(out / f"origin_layer{k}.png")
    a, b = renders[0].median_depth, renders[1].median_depth
    both = torch.isfinite(a) & torch.isfinite(b)
    ratio = torch.log(a[both] / b[both])
    report["depth_differs_over_5pct"] = round(float((ratio.abs() > math.log(1.05)).float().mean()), 4)
    report["layer0_nearer_over_5pct"] = round(float((ratio < -math.log(1.05)).float().mean()), 4)
    report["layer1_nearer_over_5pct"] = round(float((ratio > math.log(1.05)).float().mean()), 4)
    return report


def run_scene(model: torch.nn.Module, name: str, dev: torch.device, long_side: int, tol: float) -> dict:
    src_dir = HERE / "runs" / f"{name}-sharp"
    meta = json.loads((src_dir / "run.json").read_text(encoding="utf-8"))
    src = Image.open(src_dir / "source.png").convert("RGB")
    sw, sh = src.size
    f_src = float(meta["settings"]["focal_px"])
    out = OUT / name
    out.mkdir(parents=True, exist_ok=True)

    torch.cuda.synchronize()
    t0 = time.time()
    g, layer, grid = predict(model, np.array(src), f_src, dev)
    torch.cuda.synchronize()
    predict_s = time.time() - t0

    s = long_side / max(sw, sh)
    W, H = round(sw * s), round(sh * s)
    f = f_src * W / sw
    scale = max(W, H) / 1536
    dil = max(1, round(DILATE_PX * scale))
    window = max(3, round(MATCH_WINDOW * scale) | 1)
    ref = torch.from_numpy(np.array(src.resize((W, H), Image.LANCZOS))).to(dev).float() / 255

    def cam(pos: tuple[float, float, float], yaw: float) -> ts.Camera:
        return ts.Camera.pose(pos, yaw, 0, f, f, W, H, dev)

    origin_cam = cam((0, 0, 0), 0)
    origin = ts.render(g, origin_cam)
    origin_psnr = psnr(origin.color, ref)
    to_img(origin.color).save(out / "origin.png")
    layers = layer_report(g, layer, origin_cam, ref, out)
    visibility = Visibility(origin, origin_cam, tol, window)

    poses, rows = [], []
    for label, pos, yaw, preset in POSES:
        c = cam(pos, yaw)
        t0 = time.time()
        r = ts.render(g, c)
        hole = r.alpha < HOLE_ALPHA
        unseen = open_mask(visibility.unseen(r, c), OPEN_PX) & ~hole
        mask = dilate(hole | unseen, dil)
        torch.cuda.synchronize()
        dt = time.time() - t0
        slug = label.replace(" ", "_")
        to_img(r.color).save(out / f"{slug}.color.png")
        to_img(mask.float()).save(out / f"{slug}.mask.png")
        marked = to_img(overlay(r.color, unseen, hole))
        marked.save(out / f"{slug}.overlay.png")
        poses.append({
            "pose": label, "preset": preset, "position": pos, "yaw": yaw,
            "hole": round(float(hole.float().mean()), 4),
            "unseen": round(float(unseen.float().mean()), 4),
            "mask_dilated": round(float(mask.float().mean()), 4),
            "render_s": round(dt, 2), "candidates_m": round(r.candidates / 1e6, 1),
        })
        p = poses[-1]
        rows.append((f"{label}: hole {p['hole']:.1%}  unseen {p['unseen']:.1%}  mask {p['mask_dilated']:.1%}",
                     [to_img(r.color), marked]))
        print(f"  {label:14s} hole {p['hole']:6.1%}  unseen {p['unseen']:6.1%}  mask {p['mask_dilated']:6.1%}  "
              f"({dt:.1f}s)")
    sheet(rows, 384 if W >= H else 288, out / "sheet.png")

    result = {
        "scene": name, "source_size": [sw, sh], "render_size": [W, H], "hfov": meta["settings"]["hfov"],
        "gaussians": len(g), "grid": grid, "predict_s": round(predict_s, 2),
        "origin_psnr_db": round(origin_psnr, 2), "layers": layers,
        "depth_tol": tol, "match_window_px": window, "dilate_px": dil, "poses": poses,
        "peak_vram_gib": round(torch.cuda.max_memory_allocated() / 2**30, 2),
    }
    (out / "b0.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"{name}: {W}x{H}, origin PSNR {origin_psnr:.1f} dB, layers differ on "
          f"{layers['depth_differs_over_5pct']:.1%} of pixels, peak {result['peak_vram_gib']} GiB")
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenes", nargs="+")
    ap.add_argument("--long-side", type=int, default=LONG_SIDE, help="render size of the longer edge")
    ap.add_argument("--depth-tol", type=float, default=DEPTH_TOL)
    args = ap.parse_args()
    free_comfy()
    dev = torch.device("cuda")
    model = create_predictor(PredictorParams())
    model.load_state_dict(torch.load(CKPT, weights_only=True))
    model.eval().to(dev)
    OUT.mkdir(parents=True, exist_ok=True)
    summary = OUT / "b0.json"
    with torch.no_grad():
        for name in args.scenes:
            require_memory()
            torch.cuda.reset_peak_memory_stats()
            result = run_scene(model, name, dev, args.long_side, args.depth_tol)
            old = json.loads(summary.read_text(encoding="utf-8")) if summary.is_file() else {}
            old[name] = result
            summary.write_text(json.dumps(old, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
