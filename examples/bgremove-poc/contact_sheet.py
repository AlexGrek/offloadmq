"""Tile a list of images into one labelled contact sheet (for picking PoC inputs)."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw


def main(list_file: str, out: str, cell: int = 256, cols: int = 6) -> None:
    paths = [Path(p.strip().lstrip("﻿")) for p in Path(list_file).read_text("utf-8").splitlines() if p.strip()]
    rows = (len(paths) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * (cell + 16)), "white")
    draw = ImageDraw.Draw(sheet)
    for i, p in enumerate(paths):
        im = Image.open(p).convert("RGB")
        im.thumbnail((cell, cell))
        x, y = (i % cols) * cell, (i // cols) * (cell + 16)
        sheet.paste(im, (x + (cell - im.width) // 2, y + 16))
        draw.text((x + 2, y + 2), f"{i}: {p.name}", fill="black")
    sheet.save(out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
