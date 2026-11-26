"""``world.mirror`` executor — Tencent WorldMirror 2.0 on a single picture (experimental).

A feed-forward 1.2 B model predicts one Gaussian per pixel (~0.5 s of inference).
On the A1 test pictures it did **not** beat ``world.sharp``: nothing exists behind
foreground objects, so leaning opens black silhouettes. It is here to be judged in
a headset (docs/worlds-quality-plan.md).

The model's world is not metric. When the SHARP runtime is installed the agent
runs SHARP on the same picture and takes one global depth scale from it; otherwise
the median surface is placed :data:`~.mirror_scene.FALLBACK_MEDIAN_M` metres away.

The output contract matches the other ``world.*`` capabilities (``ply`` +
``preview`` bucket refs, counts, settings, timings).
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any

import numpy as np
import requests
from PIL import Image, ImageOps

from offloadmq_agent.exec.imggen.output import upload_output_file
from offloadmq_agent.exec.reporting import (
    TaskCancelled,
    make_failure_report,
    make_success_report,
    report_cancelled,
    report_progress,
    report_result,
)
from offloadmq_agent.ollama import get_ollama_base_url
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.wire import TaskId

from . import mirror_runtime as rt
from . import mirror_scene as scene
from . import sharp, sharp_runtime
from .executor import _file_ref, _input_path
from .mirror_runner import RUNNER_SOURCE
from .splat import SH_C0, SplatSettings, render_preview_sheet

logger = logging.getLogger("agent")

CAPABILITY = "world.mirror"
GENERATOR = "hy-worldmirror-2.0"
OLLAMA_UNLOAD_WAIT_S = 15.0


def _flag(payload: dict[str, Any], key: str) -> bool:
    raw = payload.get(key)
    if raw in (None, ""):
        return False
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str) and raw.strip().lower() in ("true", "false"):
        return raw.strip().lower() == "true"
    raise ValueError(f"'{key}' must be true or false, got {raw!r}")


def _free_ollama_vram(transport: AgentTransport, task_id: TaskId) -> None:
    """A loaded LLM spills WorldMirror into system memory (98 s instead of 0.4 s in A1):
    ask a co-resident Ollama to unload, and wait until it has."""
    url = get_ollama_base_url()
    try:
        loaded = requests.get(f"{url}/api/ps", timeout=5).json().get("models") or []
        if not loaded:
            return
        names = [str(m.get("model") or m.get("name")) for m in loaded]
        report_progress(transport, f"Asking Ollama to unload {', '.join(names)}", "loading", task_id)
        for name in names:
            requests.post(f"{url}/api/generate", json={"model": name, "keep_alive": 0}, timeout=30)
        deadline = time.monotonic() + OLLAMA_UNLOAD_WAIT_S
        while time.monotonic() < deadline:
            if not requests.get(f"{url}/api/ps", timeout=5).json().get("models"):
                return
            time.sleep(0.5)
        report_progress(transport, "Ollama still holds a model; inference may be slow", "loading", task_id)
    except (requests.RequestException, ValueError, AttributeError):
        pass  # no Ollama running: nothing to free


def _metric_scale(
    transport: AgentTransport,
    task_id: TaskId,
    splats: scene.Splats,
    camera: scene.Camera,
    image: Path,
    data_path: Path,
) -> tuple[float, str, dict[str, float] | None]:
    """``(scale, source, agreement with SHARP)``; source is ``sharp`` or ``median``."""
    status = sharp_runtime.status()
    if status.ready:
        report_progress(transport, "Running SHARP for a metric depth scale", "scaling", task_id)
        try:
            meta, ply = sharp.run_sharp(transport, task_id, status.paths, image, data_path, None)
            cols = sharp.read_vertex_ply(ply)
            xyz = np.stack([cols["x"], cols["y"], cols["z"]], 1).astype(np.float32)
            opacity = 1 / (1 + np.exp(-cols["opacity"].astype(np.float32)))
            w, h, f = float(meta["width"]), float(meta["height"]), float(meta["focal_px"])
            reference = scene.front_depth(xyz, opacity, scene.Camera(f, f, w / 2, h / 2, w, h))
            agreement = scene.compare_depth(reference, scene.front_depth(splats.xyz, splats.opacity, camera))
            if agreement is not None:
                return agreement["scale"], "sharp", agreement
            reason = "too little overlap with SHARP's depth"
        except (RuntimeError, OSError, ValueError, KeyError) as e:  # SHARP is optional here
            logger.warning("SHARP scale failed: %s", e)
            reason = f"SHARP failed ({str(e).splitlines()[0] if str(e) else type(e).__name__})"
    else:
        reason = "SHARP is not installed"
    report_progress(transport, f"{reason}; placing the median surface {scene.FALLBACK_MEDIAN_M:g} m away",
                    "scaling", task_id)
    return scene.fallback_scale(splats), "median", None


def execute_world_mirror(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
    job_timeout: int = 900,  # noqa: ARG001 — part of the routed contract; WorldMirror runs have no limit
) -> bool:
    """Execute a ``world.mirror`` task. Payload: ``input_image`` (+ optional ``cleanup``).

    Neither the WorldMirror run nor the SHARP scale run has a time limit; cancelling
    the task stops them. Ollama is unloaded first unless ``mirror_free_ollama`` is off."""
    try:
        if capability != CAPABILITY:
            raise ValueError(f"Unsupported capability '{capability}' (expected {CAPABILITY})")
        if not output_bucket:
            raise ValueError("world.mirror tasks require an 'output_bucket' — the PLY is uploaded there")
        if not isinstance(payload, dict):
            raise ValueError(f"Payload must be a dict, got {type(payload).__name__}")
        if payload.get("mode") == "pano":
            raise ValueError("world.mirror handles perspective pictures only; use world.splat for 360° panoramas")
        cleanup = _flag(payload, "cleanup")

        st = rt.status()
        if not st.ready:
            raise RuntimeError(st.describe())

        src_path = _input_path(payload, data_path)
        source_bytes = src_path.read_bytes()
        with Image.open(src_path) as im:
            sw, sh = ImageOps.exif_transpose(im).size

        sharp._free_comfy_vram(transport, task_id)
        if rt.free_ollama():
            _free_ollama_vram(transport, task_id)

        runner = data_path / "omq_mirror_runner.py"
        runner.write_text(RUNNER_SOURCE, encoding="utf-8")
        out_dir = data_path / "mirror_out"
        cmd = [str(st.paths.python), str(runner), "--image", str(src_path), "--out-dir", str(out_dir),
               "--root", str(st.paths.root)]
        if cleanup:
            cmd.append("--cleanup")
        report_progress(transport, f"WorldMirror on {sw}x{sh}{' with clean-up filters' if cleanup else ''}",
                        "predicting", task_id)
        # No time limit: the run ends when it finishes or the task is cancelled.
        sharp.run_runtime(transport, task_id, cmd, data_path, None, "WorldMirror")
        meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
        raw = (out_dir / "official" / "gaussians.ply").read_bytes()
        splats = scene.from_official(sharp.read_vertex_ply(raw), meta["extrinsics"])
        camera = scene.camera_from_intrinsics(meta["intrinsics"])

        t0 = time.monotonic()
        factor, scale_source, agreement = _metric_scale(
            transport, task_id, splats, camera, src_path, data_path,
        )
        scale_s = round(time.monotonic() - t0, 2)

        t0 = time.monotonic()
        splats = scene.scaled(splats, factor)
        ply = scene.write_ply(splats)
        visible = splats.opacity > 0.3  # the point preview ignores near-transparent Gaussians
        rgb = np.clip(splats.sh[visible] * SH_C0 + 0.5, 0, 1)
        preview = render_preview_sheet(
            splats.xyz[visible], rgb, SplatSettings(mode="perspective", hfov=camera.hfov),
        )
        z = splats.xyz[:, 2]
        depth_range = [float(np.percentile(z, 1)), float(np.percentile(z, 99))]
        preview_s = round(time.monotonic() - t0, 2)
        report_progress(
            transport,
            f"{len(splats):,} Gaussians, {len(ply) / 2**20:.1f} MiB, hfov {camera.hfov:.0f}°, "
            f"scale ×{factor:.2f} ({scale_source}), peak VRAM {meta.get('peak_vram_gib')} GiB",
            "uploading", task_id,
        )

        t0 = time.monotonic()
        files: dict[str, dict[str, Any]] = {}
        for key, name, ctype, content in (
            ("ply", "scene.ply", "application/octet-stream", ply),
            ("preview", "preview.png", "image/png", preview),
        ):
            uid = upload_output_file(transport, output_bucket, name, content, ctype, task_id)
            files[key] = _file_ref(name, ctype, content, uid, output_bucket)

        output: dict[str, Any] = {
            "output_bucket": output_bucket,
            "generator": GENERATOR,
            "mode": "perspective",
            "splat_count": len(splats),
            "splats_fg": len(splats),
            "splats_bg": 0,
            "depth_range_m": depth_range,
            "settings": {
                "hfov": round(camera.hfov, 2),
                "vfov": round(camera.vfov, 2),
                "cleanup": cleanup,
                "scale": round(factor, 4),
                "scale_source": scale_source,
            },
            "scale_agreement": agreement,
            "source": {"width": sw, "height": sh, "sha256": hashlib.sha256(source_bytes).hexdigest()},
            "runtime": {
                "revision": st.manifest.get("revision"), "weights_revision": st.manifest.get("weights_revision"),
                "torch": meta.get("torch"), "device": meta.get("gpu"), "peak_vram_gib": meta.get("peak_vram_gib"),
            },
            "license": rt.LICENSE_NOTICE,
            "timings": {**meta.get("timings", {}), "scale_s": scale_s, "preview_s": preview_s,
                        "upload_s": round(time.monotonic() - t0, 2)},
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
        logger.exception("world.mirror failed")
        report_progress(transport, log=f"Task failed: {e}", stage="failed", task_id=task_id)
        report = make_failure_report(task_id, capability, str(e))

    return report_result(transport, report)
