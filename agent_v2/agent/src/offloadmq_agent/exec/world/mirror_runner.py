"""Script run *inside the WorldMirror venv* by the ``world.mirror`` executor.

Kept as a string for the same reason as :mod:`.sharp_runner`: the agent never
imports torch, and frozen builds have no ``.py`` file to point the venv at.

Contract: ``--image`` (EXIF orientation applied), ``--out-dir``, ``--root`` (the
runtime directory, see :mod:`.mirror_runtime`), ``--cleanup`` (Tencent's sky and
depth-edge masks plus voxel merging). Writes the official ``official/gaussians.ply``
(unscaled, opacity as a probability) and ``meta.json`` with the predicted camera.
The agent converts and scales it.
"""

from __future__ import annotations

#: WorldMirror hard-imports FlashAttention, which has no practical Windows build.
#: This provides the one function it uses on torch's own SDPA (which has a flash
#: kernel); inputs are [batch, tokens, heads, head_dim].
SHIM_SOURCE = r'''
import sys, types
import torch.nn.functional as F


def _flash_attn_func(q, k, v, dropout_p=0.0, **_):
    return F.scaled_dot_product_attention(
        q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), dropout_p=dropout_p
    ).transpose(1, 2)


_shim = types.ModuleType("flash_attn_interface")
_shim.flash_attn_func = _flash_attn_func
sys.modules["flash_attn_interface"] = _shim
'''

RUNNER_SOURCE = SHIM_SOURCE + r'''
import argparse, json, os, time
from pathlib import Path

import torch
from PIL import Image, ImageOps

ap = argparse.ArgumentParser()
ap.add_argument("--image", required=True)
ap.add_argument("--out-dir", required=True)
ap.add_argument("--root", required=True)
ap.add_argument("--cleanup", action="store_true")
ap.add_argument("--target-size", type=int, default=952)
a = ap.parse_args()
root = Path(a.root).resolve()
out = Path(a.out_dir).resolve()
out.mkdir(parents=True, exist_ok=True)
image = out / "input.png"
with Image.open(a.image) as im:
    ImageOps.exif_transpose(im).convert("RGB").save(image)

if not torch.cuda.is_available():
    sys.exit("WorldMirror needs a CUDA GPU; torch sees none")
sys.path.insert(0, str(root / "src"))
os.chdir(root)  # the official sky mask reads skyseg.onnx from the working directory
from hyworld2.worldrecon.hyworldmirror.utils import inference_utils
from hyworld2.worldrecon.pipeline import WorldMirrorPipeline

if not a.cleanup:
    # Keep every per-pixel Gaussian. The official merge (and the model's own training
    # renderer) uses the confidence weight as opacity, so unmerged splats must too.
    inference_utils._voxel_prune_gaussians = lambda means, scales, quats, colors, opacities, weights: (
        means, scales, quats, colors, weights)

timings = {}
t = time.monotonic()
pipe = WorldMirrorPipeline.from_pretrained(str(root / "weights"))
timings["load_s"] = round(time.monotonic() - t, 2)

torch.cuda.reset_peak_memory_stats()
t = time.monotonic()
official = out / "official"
done = pipe(str(image), strict_output_path=str(official), target_size=a.target_size, save_depth=False,
            save_normal=False, save_points=False, apply_sky_mask=a.cleanup, apply_edge_mask=a.cleanup)
torch.cuda.synchronize()
timings["predict_s"] = round(time.monotonic() - t, 2)
if done is None or not (official / "gaussians.ply").is_file():
    sys.exit("WorldMirror produced no Gaussians for this picture")

camera = json.loads((official / "camera_params.json").read_text(encoding="utf-8"))
K = camera["intrinsics"][0]["matrix"]
with Image.open(image) as im:
    width, height = im.size
meta = {
    "width": width, "height": height,
    "extrinsics": camera["extrinsics"][0]["matrix"],  # camera-to-world
    "intrinsics": K,  # in processed-image pixels, principal point at its centre
    "gpu": torch.cuda.get_device_name(0),
    "peak_vram_gib": round(torch.cuda.max_memory_allocated() / 2**30, 2),
    "torch": torch.__version__, "timings": timings,
}
(out / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
print("OMQ-MIRROR-DONE", json.dumps(meta))
'''
