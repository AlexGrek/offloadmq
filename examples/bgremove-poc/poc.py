"""Background-removal PoC — compare ONNX matting/segmentation models on real images.

For each input image and each model it writes the predicted alpha, an RGBA cut-out and
a comparison grid (cut-out over a checkerboard and over a contrasting solid colour, so
halos and colour bleed are visible).

    uv run python examples/bgremove-poc/poc.py --models-dir E:/offload-agent/onnx-models \
        --out E:/bgremove-poc/runs/1 img1.png img2.png ...
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


@dataclass(frozen=True)
class ModelSpec:
    name: str
    filename: str
    size: int
    mean: tuple[float, float, float]
    std: tuple[float, float, float]
    sigmoid: bool  # raw logits out → apply sigmoid
    letterbox: bool  # keep aspect (pad) instead of stretching to a square


MODELS = [
    ModelSpec("isnet-anime", "isnet-anime.onnx", 1024, (0, 0, 0), (1, 1, 1), False, True),
    ModelSpec("rmbg-1.4", "rmbg-1.4.onnx", 1024, (0.5, 0.5, 0.5), (1, 1, 1), False, False),
    ModelSpec("birefnet-lite", "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx", 1024, IMAGENET_MEAN, IMAGENET_STD, True, False),
    ModelSpec("birefnet-general", "BiRefNet-general-epoch_244.onnx", 1024, IMAGENET_MEAN, IMAGENET_STD, True, False),
    ModelSpec("birefnet-portrait", "BiRefNet-portrait-epoch_150.onnx", 1024, IMAGENET_MEAN, IMAGENET_STD, True, False),
]


def preprocess(img: Image.Image, spec: ModelSpec) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """Return the NCHW tensor plus the (x, y, w, h) region of the model input holding the image."""
    s = spec.size
    if spec.letterbox:
        scale = s / max(img.size)
        w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
        canvas = Image.new("RGB", (s, s), (0, 0, 0))
        x, y = (s - w) // 2, (s - h) // 2
        canvas.paste(img.resize((w, h), Image.Resampling.BILINEAR), (x, y))
        box = (x, y, w, h)
    else:
        canvas = img.resize((s, s), Image.Resampling.BILINEAR)
        box = (0, 0, s, s)
    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    arr = (arr - np.array(spec.mean, np.float32)) / np.array(spec.std, np.float32)
    return arr.transpose(2, 0, 1)[None].astype(np.float32), box


def predict_alpha(sess: ort.InferenceSession, img: Image.Image, spec: ModelSpec) -> np.ndarray:
    tensor, (x, y, w, h) = preprocess(img, spec)
    out = sess.run(None, {sess.get_inputs()[0].name: tensor})[0]
    pred = out.reshape(out.shape[-2], out.shape[-1]).astype(np.float32)
    if spec.sigmoid:
        pred = 1.0 / (1.0 + np.exp(-pred))
    pred = pred[y : y + h, x : x + w]
    pred = np.clip(pred, 0.0, 1.0)
    mask = Image.fromarray((pred * 255).round().astype(np.uint8), "L")
    return np.asarray(mask.resize(img.size, Image.Resampling.BILINEAR), dtype=np.float32) / 255.0


def _box_blur(a: np.ndarray, r: int) -> np.ndarray:
    """Separable mean filter with edge clamping (works on HxW or HxWxC)."""
    def blur_axis(x: np.ndarray, axis: int) -> np.ndarray:
        pad = [(0, 0)] * x.ndim
        pad[axis] = (r + 1, r)
        c = np.cumsum(np.pad(x, pad, mode="edge"), axis=axis, dtype=np.float64)
        n = x.shape[axis]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        return ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return blur_axis(blur_axis(a, 0), 1)


def estimate_foreground(image: np.ndarray, alpha: np.ndarray, radii: tuple[int, ...] = (45, 3)) -> np.ndarray:
    """Blur-fusion foreground colour estimation (Forte & Pitié 2021, "Approximate Fast
    Foreground Colour Estimation"). Removes the old background's colour from semi-
    transparent edge pixels so hair doesn't carry a halo onto the new background."""
    a = alpha[..., None]
    fg = image.copy()
    bg = image.copy()
    for r in radii:
        blurred_a = _box_blur(a, r)
        blurred_fa = _box_blur(fg * a, r) / (blurred_a + 1e-5)
        blurred_b1a = _box_blur(bg * (1 - a), r) / (_box_blur(1 - a, r) + 1e-5)
        fg = blurred_fa + a * (image - a * blurred_fa - (1 - a) * blurred_b1a)
        fg = np.clip(fg, 0, 1)
        bg = blurred_b1a
    return fg


def checkerboard(w: int, h: int, cell: int = 16) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    board = (((xx // cell) + (yy // cell)) % 2).astype(np.float32)
    return np.repeat((0.6 + 0.3 * board)[..., None], 3, axis=2)


def composite(fg: np.ndarray, alpha: np.ndarray, bg: np.ndarray) -> np.ndarray:
    a = alpha[..., None]
    return fg * a + bg * (1 - a)


def to_img(a: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(a, 0, 1) * 255).round().astype(np.uint8))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("images", nargs="+")
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--models", default=",".join(m.name for m in MODELS))
    ap.add_argument("--cell", type=int, default=420)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    wanted = args.models.split(",")
    specs = [m for m in MODELS if m.name in wanted]
    timings: dict[str, list[float]] = {m.name: [] for m in specs}

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    results: dict[str, dict[str, np.ndarray]] = {}
    for spec in specs:
        t0 = time.perf_counter()
        sess = ort.InferenceSession(str(Path(args.models_dir) / spec.filename), opts, providers=["CPUExecutionProvider"])
        print(f"[{spec.name}] loaded in {time.perf_counter() - t0:.1f}s")
        for path in args.images:
            img = Image.open(path).convert("RGB")
            t0 = time.perf_counter()
            alpha = predict_alpha(sess, img, spec)
            dt = time.perf_counter() - t0
            timings[spec.name].append(dt)
            print(f"[{spec.name}] {Path(path).name}: {dt:.2f}s")
            results.setdefault(path, {})[spec.name] = alpha
        del sess

    # Per image: one row per model — mask | checkerboard (raw fg) | magenta raw | magenta decontaminated
    magenta = np.array([1.0, 0.0, 1.0], np.float32)
    for path, per_model in results.items():
        img = Image.open(path).convert("RGB")
        rgb = np.asarray(img, dtype=np.float32) / 255.0
        h, w = rgb.shape[:2]
        c = args.cell
        th = round(h * c / w)
        cols = ["input / mask", "checker", "solid (raw)", "solid (fg-decontam)"]
        sheet = Image.new("RGB", (c * len(cols) + 140, (th + 4) * (len(per_model) + 1) + 20), "white")
        draw = ImageDraw.Draw(sheet)
        for i, label in enumerate(cols):
            draw.text((140 + i * c + 4, 4), label, fill="black")
        sheet.paste(img.resize((c, th)), (140, 20))
        stem = Path(path).stem
        for row, (name, alpha) in enumerate(per_model.items(), start=1):
            fg = estimate_foreground(rgb, alpha)
            tiles = [
                to_img(np.repeat(alpha[..., None], 3, axis=2)),
                to_img(composite(rgb, alpha, checkerboard(w, h))),
                to_img(composite(rgb, alpha, np.broadcast_to(magenta, rgb.shape))),
                to_img(composite(fg, alpha, np.broadcast_to(magenta, rgb.shape))),
            ]
            y = 20 + row * (th + 4)
            draw.text((4, y + 4), name, fill="black")
            for i, t in enumerate(tiles):
                sheet.paste(t.resize((c, th)), (140 + i * c, y))
            rgba = np.dstack([fg, alpha])
            Image.fromarray((rgba * 255).round().astype(np.uint8), "RGBA").save(out / f"{stem}.{name}.png")
        sheet.save(out / f"{stem}.grid.jpg", quality=88)

    summary = {k: {"mean_s": round(float(np.mean(v)), 2), "max_s": round(float(np.max(v)), 2)} for k, v in timings.items()}
    (out / "timings.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
