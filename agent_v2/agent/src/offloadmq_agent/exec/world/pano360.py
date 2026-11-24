"""``world.pano360`` executor — one perspective picture in, a full 360° splat world out.

WorldGen's image-to-scene recipe (ZiYang-xie/WorldGen) on the local ComfyUI:

1. **project** the picture onto a 2:1 equirectangular canvas at an assumed
   horizontal FOV and camera pitch; everything it does not cover is to be generated;
2. **outpaint** the sphere with FLUX.1-dev + WorldGen's ``worldgen_text2scene``
   panorama LoRA (masked-latent inpainting + differential diffusion, 1600×800);
3. **seam**: roll the panorama 180° and re-inpaint the left/right wrap seam;
4. **paste** the original pixels back at canvas resolution (feathered);
5. **splat**: Lotus depth on the panorama (the ``world.splat`` depth workflow) →
   :func:`.splat.build_world` in ``pano`` mode.

Output matches ``world.splat`` (``ply``/``preview``/``depth`` refs, counts, settings)
plus a ``panorama`` JPEG ref. Validated in ``examples/vr-world-poc/worldgen_poc.py``;
contract in docs/agent-capabilities.md (``world.pano360``).
"""

from __future__ import annotations

import hashlib
import io
import logging
import random
import time
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
import requests
from PIL import Image, ImageFilter, ImageOps

from offloadmq_agent.exec.imggen.comfyui import download_file, queue_prompt, upload_image, wait_for_completion
from offloadmq_agent.exec.imggen.output import upload_output_file
from offloadmq_agent.exec.reporting import (
    TaskCancelled,
    make_failure_report,
    make_success_report,
    report_cancelled,
    report_progress,
    report_result,
)
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.wire import TaskId

from . import pano360_runtime as rt
from .executor import MAX_WIDTH_LIMIT, _file_ref, _first_output_image, _input_path, _num, _run_depth
from .splat import SplatSettings, build_world

Arr = npt.NDArray[Any]
logger = logging.getLogger("agent")

CAPABILITY = "world.pano360"
GENERATOR = "worldgen-flux-pano-v1"
PROMPT_PREFIX = "A high quality 360 panorama photo of"
PROMPT_SUFFIX = "HDR, RAW, 360 consistent, omnidirectional"
CANVAS_WIDTH = 2048          # final panorama (height = width / 2)
GEN_WIDTH = 1600             # FLUX outpaint resolution (WorldGen's default)
SEAM_FRACTION = 0.12         # width of the re-inpainted wrap seam band
SEAM_DENOISE = 0.85
BLEND_FRACTION = 0.03        # generation feather into the picture, as a fraction of the canvas width
PASTE_RADIUS = 4             # paste-back ramp inside the picture edge (px at canvas width)
MAX_PROMPT_CHARS = 2000


# --------------------------------------------------------------------------- geometry


def pano_dirs(w: int, h: int) -> Arr:
    """Unit ray per equirect pixel, OpenCV frame — matches :func:`.splat.backproject` (pano)."""
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    lon = (u / w - 0.5) * 2 * np.pi
    lat = (0.5 - v / h) * np.pi
    out: Arr = np.stack([np.cos(lat) * np.sin(lon), -np.sin(lat), np.cos(lat) * np.cos(lon)], -1)
    return out


def _bilinear(img: Arr, x: Arr, y: Arr) -> Arr:
    h, w = img.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1.001)
    y = np.clip(y - 0.5, 0, h - 1.001)
    x0, y0 = x.astype(np.int64), y.astype(np.int64)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    top = img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx
    bot = img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx
    out: Arr = top * (1 - fy) + bot * fy
    return out


def project_to_pano(src: Image.Image, hfov: float, pitch: float, w: int, h: int) -> tuple[Arr, Arr]:
    """``(rgb float HxWx3, covered bool HxW)`` for a camera at longitude 0.

    ``pitch`` in degrees; negative = the camera looks down (picture below the horizon).
    """
    img = np.asarray(src.convert("RGB"), dtype=np.float32) / 255.0
    sh, sw = img.shape[:2]
    f = 0.5 * sw / np.tan(np.radians(hfov) / 2)
    dw = pano_dirs(w, h)
    a = np.radians(-pitch)
    down = np.array([0.0, np.cos(a), -np.sin(a)])
    fwd = np.array([0.0, np.sin(a), np.cos(a)])
    d = np.stack([dw[..., 0], dw @ down, dw @ fwd], -1)  # world ray in the camera frame
    z = d[..., 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        px = d[..., 0] / z * f + sw / 2
        py = d[..., 1] / z * f + sh / 2
    covered: Arr = (z > 1e-3) & (px >= 0) & (px < sw) & (py >= 0) & (py < sh)
    rgb = np.zeros((h, w, 3), np.float32)
    rgb[covered] = _bilinear(img, px[covered], py[covered])
    return rgb, covered


def _resize_f(a: Arr, size: tuple[int, int], method: Image.Resampling) -> Arr:
    """Resize a float32 HxW array (PIL mode F)."""
    out: Arr = np.asarray(Image.fromarray(a.astype(np.float32)).resize(size, method), np.float32)
    return out


def pull_push_fill(rgb: Arr, valid: Arr) -> Arr:
    """Fill the uncovered sphere with a smooth extension of the picture (mip pull-push).

    The outpaint starts from this, so it must carry the picture's colours — an empty
    (black) seed made FLUX paint a dark room around the picture in the PoC.
    """
    wgt = valid.astype(np.float32)
    levels = [(rgb * wgt[..., None], wgt)]
    while min(levels[-1][1].shape) > 4:
        c, m = levels[-1]
        size = (max(c.shape[1] // 2, 1), max(c.shape[0] // 2, 1))
        levels.append((np.stack([_resize_f(c[..., i], size, Image.Resampling.BOX) for i in range(3)], -1),
                       _resize_f(m, size, Image.Resampling.BOX)))
    c, m = levels[-1]
    mean = rgb[valid].mean(0) if valid.any() else np.full(3, 0.5, np.float32)
    cur = np.where((m > 0)[..., None], c / np.maximum(m, 1e-6)[..., None], mean)
    for c, m in reversed(levels[:-1]):
        size = (m.shape[1], m.shape[0])
        up = np.stack([_resize_f(cur[..., i], size, Image.Resampling.BILINEAR) for i in range(3)], -1)
        own = c / np.maximum(m, 1e-6)[..., None]
        alpha = np.clip(m * 4, 0, 1)[..., None]
        cur = own * alpha + up * (1 - alpha)
    out: Arr = np.where(valid[..., None], rgb, cur).astype(np.float32)
    return out


def feather(mask: Arr, radius: int) -> Arr:
    """1 = regenerate. Ramps ``radius`` px into the kept region so the boundary blends."""
    hard = Image.fromarray((mask.astype(np.uint8) * 255))
    soft = np.asarray(hard.filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255.0
    out: Arr = np.maximum(mask.astype(np.float32), np.clip(soft * 2, 0, 1))
    return out


def paste_alpha(covered: Arr, radius: int) -> Arr:
    """Weight of the original picture in the final panorama: 1 inside, ramping to 0 over
    ``radius`` px *inside* its edge. Deliberately much narrower than the generation
    feather: FLUX + differential diffusion leaves a diagonal patch-grid pattern where
    the mask is partial, so those pixels must come from the original."""
    hard = Image.fromarray(covered.astype(np.uint8) * 255)
    soft = np.asarray(hard.filter(ImageFilter.GaussianBlur(radius)), np.float32) / 255.0
    out: Arr = np.clip(soft * 2 - 1, 0, 1) * covered
    return out


def to_rgba(rgb: Arr, regen: Arr) -> Image.Image:
    """ComfyUI's LoadImage turns alpha into MASK = 1 - alpha (1 = regenerate)."""
    a = ((1 - regen) * 255).round().astype(np.uint8)
    c = (np.clip(rgb, 0, 1) * 255).round().astype(np.uint8)
    return Image.fromarray(np.dstack([c, a]), "RGBA")


def resize_rgb(a: Arr, w: int, h: int) -> Arr:
    img = Image.fromarray((np.clip(a, 0, 1) * 255).round().astype(np.uint8))
    out: Arr = np.asarray(img.resize((w, h), Image.Resampling.LANCZOS), np.float32) / 255.0
    return out


def seam_band(w: int, h: int, fraction: float = SEAM_FRACTION) -> Arr:
    band = np.zeros((h, w), bool)
    half = max(1, int(w * fraction / 2))
    band[:, w // 2 - half: w // 2 + half] = True
    return band


# --------------------------------------------------------------------------- ComfyUI graph


def outpaint_graph(image_name: str, prompt: str, models: rt.Pano360Models, w: int, h: int,
                   seed: int, steps: int, guidance: float, denoise: float) -> dict[str, Any]:
    """FLUX.1-dev + WorldGen LoRA masked-latent inpainting with differential diffusion."""
    return {
        "unet": {"class_type": "UNETLoader", "inputs": {"unet_name": models.unet, "weight_dtype": "default"}},
        "lora": {"class_type": "LoraLoaderModelOnly",
                 "inputs": {"lora_name": models.lora, "strength_model": 1.0, "model": ["unet", 0]}},
        "msf": {"class_type": "ModelSamplingFlux",
                "inputs": {"max_shift": 1.15, "base_shift": 0.5, "width": w, "height": h, "model": ["lora", 0]}},
        "dd": {"class_type": "DifferentialDiffusion", "inputs": {"model": ["msf", 0]}},
        "clip": {"class_type": "DualCLIPLoader",
                 "inputs": {"clip_name1": models.clip_l, "clip_name2": models.t5, "type": "flux", "device": "default"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": models.vae}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["clip", 0]}},
        "guid": {"class_type": "FluxGuidance", "inputs": {"guidance": guidance, "conditioning": ["pos", 0]}},
        "neg": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["pos", 0]}},
        "load": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "scale": {"class_type": "ImageScale", "inputs": {"image": ["load", 0], "upscale_method": "lanczos",
                                                          "width": w, "height": h, "crop": "disabled"}},
        "enc": {"class_type": "VAEEncode", "inputs": {"pixels": ["scale", 0], "vae": ["vae", 0]}},
        "nm": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["enc", 0], "mask": ["load", 1]}},
        "ks": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
            "denoise": denoise, "model": ["dd", 0], "positive": ["guid", 0], "negative": ["neg", 0],
            "latent_image": ["nm", 0]}},
        "dec": {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage", "inputs": {"filename_prefix": "omq-pano360", "images": ["dec", 0]}},
    }


def _inpaint(transport: AgentTransport, task_id: TaskId, rgba: Image.Image, path: Path, graph_args: dict[str, Any],
             stage: str, job_timeout: int) -> tuple[Arr, str]:
    rgba.save(path, format="PNG")
    name = upload_image(path)
    graph = outpaint_graph(name, **graph_args)
    prompt_id = queue_prompt(graph, transport, task_id)
    report_progress(transport, f"{stage} queued as prompt_id={prompt_id}", stage, task_id)
    entry = wait_for_completion(prompt_id, transport, task_id, job_timeout)
    content, _ = download_file(*_first_output_image(entry))
    img = Image.open(io.BytesIO(content)).convert("RGB")
    return np.asarray(img, np.float32) / 255.0, prompt_id


# --------------------------------------------------------------------------- payload


def parse_options(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("mode") == "pano":
        raise ValueError("world.pano360 extends a perspective picture; pass a 2:1 panorama to world.splat instead")
    prompt = payload.get("prompt")
    if prompt is not None and not isinstance(prompt, str):
        raise ValueError("'prompt' must be a string")
    prompt = " ".join((prompt or "").split())[:MAX_PROMPT_CHARS] or "a scene"
    raw_seed = payload.get("seed")
    if raw_seed in (None, ""):
        seed = random.randint(0, 2**48)
    else:
        try:
            seed = int(raw_seed)  # type: ignore[arg-type]
        except (TypeError, ValueError) as e:
            raise ValueError(f"'seed' must be an integer, got {raw_seed!r}") from e
        seed = min(max(seed, 0), 2**53)
    near = _num(payload, "near", 1.2, 0.1, 20.0)
    return {
        "prompt": prompt,
        "hfov": _num(payload, "hfov", 70.0, 30.0, 120.0),
        "pitch": _num(payload, "pitch", 0.0, -60.0, 60.0),
        "seed": seed,
        "steps": int(_num(payload, "steps", 28, 8, 50)),
        "guidance": _num(payload, "guidance", 4.0, 1.0, 10.0),
        "denoise": _num(payload, "denoise", 1.0, 0.5, 1.0),  # <1 leaves a patch-grid pattern
        "near": near,
        "far": _num(payload, "far", 50.0, near + 0.5, 1000.0),
        "fill_lean": _num(payload, "fill_lean", 0.25, 0.0, 1.0),
        "max_width": int(_num(payload, "max_width", 1536, 256, MAX_WIDTH_LIMIT)),
    }


# --------------------------------------------------------------------------- executor


def execute_world_pano360(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
    job_timeout: int = 600,
) -> bool:
    """Execute a ``world.pano360`` task. Payload: see docs/agent-capabilities.md."""
    try:
        if capability != CAPABILITY:
            raise ValueError(f"Unsupported capability '{capability}' (expected {CAPABILITY})")
        if not output_bucket:
            raise ValueError("world.pano360 tasks require an 'output_bucket' — the PLY is uploaded there")
        if not isinstance(payload, dict):
            raise ValueError(f"Payload must be a dict, got {type(payload).__name__}")

        opts = parse_options(payload)
        st = rt.status()
        if not st.ready:
            raise RuntimeError(f"world.pano360 is not ready: {st.describe()}")
        models = st.models

        timings: dict[str, float] = {}
        src_path = _input_path(payload, data_path)
        source_bytes = src_path.read_bytes()
        source = ImageOps.exif_transpose(Image.open(io.BytesIO(source_bytes))).convert("RGB")

        cw, ch = CANVAS_WIDTH, CANVAS_WIDTH // 2
        gw, gh = GEN_WIDTH, GEN_WIDTH // 2
        t0 = time.monotonic()
        rgb, covered = project_to_pano(source, opts["hfov"], opts["pitch"], cw, ch)
        if not covered.any():
            raise ValueError("the picture does not land on the panorama — check hfov/pitch")
        regen = feather(~covered, max(4, int(cw * BLEND_FRACTION)))
        seeded = pull_push_fill(rgb, covered)
        timings["project_s"] = round(time.monotonic() - t0, 2)
        coverage = float(covered.mean())
        report_progress(
            transport,
            f"Picture {source.width}x{source.height} at hfov {opts['hfov']:.0f}°, pitch {opts['pitch']:.0f}° "
            f"covers {coverage * 100:.1f}% of the sphere; outpainting the rest with {models.unet}",
            "outpaint", task_id,
        )

        prompt = f"{PROMPT_PREFIX} {opts['prompt']} {PROMPT_SUFFIX}"
        common = {"prompt": prompt, "models": models, "w": gw, "h": gh,
                  "steps": opts["steps"], "guidance": opts["guidance"]}
        uid = "".join(ch_ for ch_ in str(task_id.id) if ch_.isalnum())[:32] or "task"

        t0 = time.monotonic()
        raw, pid_fill = _inpaint(
            transport, task_id, to_rgba(resize_rgb(seeded, gw, gh), _resize_f(regen, (gw, gh), Image.Resampling.BILINEAR)),
            data_path / f"omq_pano360_{uid}_fill.png",
            {**common, "seed": opts["seed"], "denoise": opts["denoise"]}, "outpaint", job_timeout,
        )
        timings["outpaint_s"] = round(time.monotonic() - t0, 2)

        t0 = time.monotonic()
        rolled = np.roll(raw, gw // 2, axis=1)
        band = feather(seam_band(gw, gh), max(4, gw // 64))
        fixed, pid_seam = _inpaint(
            transport, task_id, to_rgba(rolled, band), data_path / f"omq_pano360_{uid}_seam.png",
            {**common, "seed": opts["seed"] + 1, "denoise": SEAM_DENOISE}, "seam", job_timeout,
        )
        fixed = rolled * (1 - band[..., None]) + fixed * band[..., None]
        generated = np.roll(fixed, -(gw // 2), axis=1)
        timings["seam_s"] = round(time.monotonic() - t0, 2)

        keep = paste_alpha(covered, PASTE_RADIUS)[..., None]
        pano_arr = rgb * keep + resize_rgb(generated, cw, ch) * (1 - keep)
        pano = Image.fromarray((np.clip(pano_arr, 0, 1) * 255).round().astype(np.uint8))
        pano_name = "world_pano.png"
        pano.save(data_path / pano_name, format="PNG")

        t0 = time.monotonic()
        depth, pid_depth = _run_depth(transport, task_id, pano_name, data_path, job_timeout)
        timings["depth_s"] = round(time.monotonic() - t0, 2)

        report_progress(transport, "Building Gaussian splat", "splatting", task_id)
        t0 = time.monotonic()
        settings = SplatSettings(mode="pano", near=opts["near"], far=opts["far"],
                                 fill_lean=opts["fill_lean"], max_width=opts["max_width"])
        world = build_world(pano, depth, settings)
        timings["splat_s"] = round(time.monotonic() - t0, 2)
        report_progress(
            transport,
            f"{world.splat_count:,} splats ({world.splats_bg:,} hidden background), "
            f"{len(world.ply) / 2**20:.1f} MiB, depth {world.depth_min:.2f}..{world.depth_max:.2f} m",
            "uploading", task_id,
        )

        t0 = time.monotonic()
        depth_buf, pano_buf = io.BytesIO(), io.BytesIO()
        depth.convert("L").save(depth_buf, format="PNG")
        pano.save(pano_buf, format="JPEG", quality=92)
        files: dict[str, dict[str, Any]] = {}
        for key, name, ctype, content in (
            ("ply", "scene.ply", "application/octet-stream", world.ply),
            ("preview", "preview.png", "image/png", world.preview_png),
            ("depth", "depth.png", "image/png", depth_buf.getvalue()),
            ("panorama", "panorama.jpg", "image/jpeg", pano_buf.getvalue()),
        ):
            file_uid = upload_output_file(transport, output_bucket, name, content, ctype, task_id)
            files[key] = _file_ref(name, ctype, content, file_uid, output_bucket)
        timings["upload_s"] = round(time.monotonic() - t0, 2)

        output: dict[str, Any] = {
            "output_bucket": output_bucket,
            "generator": GENERATOR,
            "mode": "pano",
            "splat_count": world.splat_count,
            "splats_fg": world.splats_fg,
            "splats_bg": world.splats_bg,
            "grid": {"width": world.grid_width, "height": world.grid_height},
            "depth_range_m": [world.depth_min, world.depth_max],
            "coverage": round(coverage, 4),
            "settings": {k: opts[k] for k in ("hfov", "pitch", "seed", "steps", "guidance", "denoise",
                                              "near", "far", "fill_lean", "max_width")} | {"prompt": opts["prompt"]},
            "models": models.to_dict(),
            "source": {"width": source.width, "height": source.height,
                       "sha256": hashlib.sha256(source_bytes).hexdigest()},
            "prompt_ids": {"outpaint": pid_fill, "seam": pid_seam, "depth": pid_depth},
            "timings": timings,
            **files,
        }
        report = make_success_report(task_id, capability, output)

    except TaskCancelled:
        report_cancelled(transport, task_id, capability, output={"cancelled": True})
        return True
    except requests.RequestException as e:
        resp = getattr(e, "response", None)
        body = resp.text.strip() if resp is not None else "no response"
        report_progress(transport, log=f"HTTP error: {e}\nResponse: {body}", stage="failed", task_id=task_id)
        report = make_failure_report(task_id, capability, str(e),
                                     extra_output={"error": str(e), "response_body": body})
    except Exception as e:  # noqa: BLE001 — every failure must resolve the task
        logger.exception("world.pano360 failed")
        report_progress(transport, log=f"Task failed: {e}", stage="failed", task_id=task_id)
        report = make_failure_report(task_id, capability, str(e))

    return report_result(transport, report)
