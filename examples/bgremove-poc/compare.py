"""Compact side-by-side sheet: original + each model's cut-out on a flat colour.

    uv run python examples/bgremove-poc/compare.py RUN_DIR OUT.jpg STEM [STEM ...] \
        [--models a,b,c] [--bg 40,160,90] [--cell 300] [--crop x0,y0,x1,y1]
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw

DEFAULT_MODELS = "isnet-anime,rmbg-1.4,birefnet-lite,birefnet-general,birefnet-portrait"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir")
    ap.add_argument("out")
    ap.add_argument("stems", nargs="+")
    ap.add_argument("--models", default=DEFAULT_MODELS)
    ap.add_argument("--bg", default="40,160,90")
    ap.add_argument("--cell", type=int, default=300)
    ap.add_argument("--crop", default=None, help="fractional box x0,y0,x1,y1 to zoom into")
    ap.add_argument("--originals", default="C:/AI/output")
    args = ap.parse_args()

    run = Path(args.run_dir)
    models = args.models.split(",")
    bg = tuple(int(c) for c in args.bg.split(","))
    crop = tuple(float(c) for c in args.crop.split(",")) if args.crop else None
    c = args.cell

    def prep(im: Image.Image) -> Image.Image:
        if crop:
            w, h = im.size
            im = im.crop((int(crop[0] * w), int(crop[1] * h), int(crop[2] * w), int(crop[3] * h)))
        return im.resize((c, round(im.height * c / im.width)), Image.Resampling.LANCZOS)

    rows = []
    for stem in args.stems:
        tiles = [prep(Image.open(Path(args.originals) / f"{stem}.png").convert("RGB"))]
        for m in models:
            cut = Image.open(run / f"{stem}.{m}.png").convert("RGBA")
            flat = Image.new("RGBA", cut.size, bg + (255,))
            flat.alpha_composite(cut)
            tiles.append(prep(flat.convert("RGB")))
        rows.append(tiles)

    th = max(t.height for r in rows for t in r)
    sheet = Image.new("RGB", (c * (len(models) + 1), 16 + len(rows) * (th + 4)), "white")
    d = ImageDraw.Draw(sheet)
    for i, label in enumerate(["original"] + models):
        d.text((i * c + 4, 2), label, fill="black")
    for r, tiles in enumerate(rows):
        for i, t in enumerate(tiles):
            sheet.paste(t, (i * c, 16 + r * (th + 4)))
    sheet.save(args.out, quality=90)


if __name__ == "__main__":
    main()
