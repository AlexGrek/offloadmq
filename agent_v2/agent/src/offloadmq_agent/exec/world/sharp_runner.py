"""Script run *inside the SHARP venv* by the ``world.sharp`` executor.

Kept as a string (not an importable module) because the agent never imports
torch/sharp itself, and frozen builds have no ``.py`` sources on disk to point
the venv's interpreter at: the executor writes :data:`RUNNER_SOURCE` into the
task directory and runs it with the venv's python.

Contract: ``--image`` (any Pillow/HEIC image; EXIF orientation applied),
``--out-dir``, ``--checkpoint``, optional ``--hfov`` (degrees; otherwise
SHARP reads the focal length from EXIF, else assumes 30 mm). Writes
``scene.ply`` (3DGS ``vertex`` element only, encoded like SHARP's ``save_ply``
but vectorised and without its metadata elements, which some viewers reject)
and ``meta.json``.
"""

from __future__ import annotations

RUNNER_SOURCE = r'''
import argparse, json, math, time
from pathlib import Path

import numpy as np
import torch

from sharp.cli.predict import predict_image
from sharp.models import PredictorParams, create_predictor
from sharp.utils import color_space, io
from sharp.utils.gaussians import convert_rgb_to_spherical_harmonics

FIELDS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
          "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


def write_vertex_ply(g, path):
    """sharp.utils.gaussians.save_ply's vertex encoding (sRGB SH0, logit opacity,
    log scale, wxyz quaternion), vectorised and without SHARP's metadata elements."""
    op = g.opacities.flatten(0, 1).unsqueeze(-1)
    cols = torch.cat((
        g.mean_vectors.flatten(0, 1),
        convert_rgb_to_spherical_harmonics(color_space.linearRGB2sRGB(g.colors.flatten(0, 1))),
        torch.log(op / (1.0 - op)),
        torch.log(g.singular_values).flatten(0, 1),
        g.quaternions.flatten(0, 1),
    ), dim=1).detach().float().cpu().numpy().astype("<f4")
    lines = ["ply", "format binary_little_endian 1.0", f"element vertex {len(cols)}"]
    lines += [f"property float {f}" for f in FIELDS] + ["end_header", ""]
    header = chr(10).join(lines)
    with open(path, "wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(np.ascontiguousarray(cols).tobytes())
    return len(cols)

ap = argparse.ArgumentParser()
ap.add_argument("--image", required=True)
ap.add_argument("--out-dir", required=True)
ap.add_argument("--checkpoint", required=True)
ap.add_argument("--hfov", type=float, default=0.0)
ap.add_argument("--device", default="default")
a = ap.parse_args()
out = Path(a.out_dir)
out.mkdir(parents=True, exist_ok=True)
timings = {}

t = time.monotonic()
image, _, f_exif = io.load_rgb(Path(a.image))
h, w = image.shape[:2]
f_px = 0.5 * w / math.tan(math.radians(a.hfov) / 2) if a.hfov > 0 else float(f_exif)
device = a.device
if device == "default":
    device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
model = create_predictor(PredictorParams())
model.load_state_dict(torch.load(a.checkpoint, weights_only=True))
model.eval().to(device)
timings["load_s"] = round(time.monotonic() - t, 2)

if device == "cuda":
    torch.cuda.reset_peak_memory_stats()
t = time.monotonic()
gaussians = predict_image(model, image, f_px, torch.device(device))
if device == "cuda":
    torch.cuda.synchronize()
timings["predict_s"] = round(time.monotonic() - t, 2)

t = time.monotonic()
count = write_vertex_ply(gaussians, out / "scene.ply")
timings["save_s"] = round(time.monotonic() - t, 2)

meta = {
    "width": w, "height": h, "focal_px": f_px,
    "hfov": math.degrees(2 * math.atan(0.5 * w / f_px)),
    "focal_source": "hfov" if a.hfov > 0 else "exif_or_default",
    "count": count, "device": device,
    "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None,
    "peak_vram_gib": round(torch.cuda.max_memory_allocated() / 2**30, 2) if device == "cuda" else None,
    "torch": torch.__version__, "timings": timings,
}
(out / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
print("OMQ-SHARP-DONE", json.dumps(meta))
'''
