"""Per-scene A1 comparison sheets (SHARP vs WorldMirror variants) from capture.mjs renders.

  E:/hyworld-poc/venv/Scripts/python.exe a1_sheets.py   # -> runs/_capture/a1-<scene>-{a,b}.png
"""
from pathlib import Path

from PIL import Image, ImageDraw

cap = Path(__file__).resolve().parent / "runs" / "_capture"
poses = ["centre", "lean_L_20cm", "lean_R_20cm", "lean_L_40cm", "step_fwd_50cm", "step_fwd_1m", "step_L_1m", "turn_L_35deg", "turn_90"]
rows = [("sharp", "SHARP"), ("wm", "WorldMirror official"), ("wm-dense", "WM no voxel merge"), ("wm-nosky", "WM no sky mask"), ("wm-noedge", "WM no edge mask"), ("wm-full", "WM all pixels (no masks, no merge)")]
tw, th, missing = 288, 192, []
for scene in ["torii", "temple", "courtyard-01", "market", "forest"]:
    for part, cols in (("a", poses[:4] + poses[4:5]), ("b", poses[5:])):
        s = Image.new("RGB", (tw * len(cols), (th + 18) * len(rows)), (60, 0, 60))
        d = ImageDraw.Draw(s)
        for r, (sfx, label) in enumerate(rows):
            for c, p in enumerate(cols):
                f = cap / f"{scene}-{sfx}__{p}.png"
                if f.exists():
                    s.paste(Image.open(f).convert("RGB").resize((tw, th)), (c * tw, r * (th + 18) + 18))
                else:
                    missing.append(f.name)
                d.rectangle((c * tw, r * (th + 18), (c + 1) * tw, r * (th + 18) + 17), fill=(20, 20, 20))
                d.text((c * tw + 4, r * (th + 18) + 3), f"{label} | {p.replace('_', ' ')}", fill=(235, 235, 235))
        s.save(cap / f"a1-{scene}-{part}.png")
print("missing", missing)
