"""Put B0 renders next to Spark captures of the same poses, and score their agreement.

First capture the poses with ``capture.mjs`` into runs/_fill/_spark/ (see
docs/worlds-fill-plan.md), then:

  E:/offload-agent/sharp/.venv/Scripts/python.exe sharp_fill_compare.py forest courtyard-01

Writes runs/_fill/<name>/spark.png (columns: Spark, torch_splat, mask overlay).
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

FILL = Path(__file__).resolve().parent / "runs" / "_fill"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenes", nargs="+")
    for name in ap.parse_args().scenes:
        rows = []
        for shot in sorted((FILL / "_spark").glob(f"{name}-sharp__*.png")):
            pose = shot.stem.split("__", 1)[1]
            spark = Image.open(shot).convert("RGB")
            ours = Image.open(FILL / name / f"{pose}.color.png").convert("RGB")
            overlay = Image.open(FILL / name / f"{pose}.overlay.png").convert("RGB")
            # The capture keeps the horizontal FOV, so match widths and crop the middle rows.
            w = spark.width
            h = round(ours.height * w / ours.width)
            ch = min(h, spark.height)

            def middle(im: Image.Image) -> Image.Image:
                top = (im.height - ch) // 2
                return im.crop((0, top, w, top + ch))

            tiles = [middle(spark), middle(ours.resize((w, h))), middle(overlay.resize((w, h)))]
            a, b = (np.asarray(t, np.float32) / 255 for t in tiles[:2])
            score = 10 * math.log10(1 / max(float(((a - b) ** 2).mean()), 1e-12))
            print(f"{name:14s} {pose:16s} Spark vs torch_splat {score:5.1f} dB")
            rows.append((f"{pose}   {score:.1f} dB   (Spark | torch_splat | masks)", tiles))
        if not rows:
            raise SystemExit(f"no Spark captures for {name}")
        tw = 480
        th = rows[0][1][0].height * tw // rows[0][1][0].width
        canvas = Image.new("RGB", (3 * tw + 8, len(rows) * (th + 18)), (20, 20, 20))
        d = ImageDraw.Draw(canvas)
        for r, (label, tiles) in enumerate(rows):
            y = r * (th + 18)
            d.text((4, y + 3), label, fill=(230, 230, 230))
            for c, t in enumerate(tiles):
                canvas.paste(t.resize((tw, th)), (c * (tw + 4), y + 18))
        canvas.save(FILL / name / "spark.png")


if __name__ == "__main__":
    main()
