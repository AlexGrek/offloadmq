"""``world.sharp`` executor — one image in, an Apple SHARP Gaussian-splat world out.

SHARP predicts a real 3DGS scene (~1.2 M learned Gaussians, metric scale) in one
forward pass, so leaning and short steps stay solid where ``world.splat``'s
per-pixel discs tear. It only covers what the picture shows (no 360°).

SHARP runs in its own venv (see :mod:`.sharp_runtime`; installed on demand by
``omq sharp install`` / the GUI) via :data:`.sharp_runner.RUNNER_SOURCE`. The
output contract matches ``world.splat`` (``ply`` + ``preview`` bucket refs, counts,
settings, timings) so OAI treats both generators alike.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import numpy as np
import requests
from PIL import Image, ImageOps

from offloadmq_agent.exec.imggen.comfyui import comfyui_url
from offloadmq_agent.exec.imggen.output import upload_output_file
from offloadmq_agent.exec.llm_runtime import run_process
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

from . import sharp_runtime as rt
from .executor import _file_ref, _input_path, _num
from .sharp_runner import RUNNER_SOURCE
from .splat import SH_C0, SplatSettings, render_preview_sheet

logger = logging.getLogger("agent")

CAPABILITY = "world.sharp"
GENERATOR = "apple-sharp"
PROGRESS_EVERY_S = 3.0
_PLY_TYPES = {"float": "<f4", "float32": "<f4", "double": "<f8", "uchar": "u1", "uint8": "u1",
              "int": "<i4", "int32": "<i4", "uint": "<u4", "uint32": "<u4", "short": "<i2", "ushort": "<u2"}


def read_vertex_ply(data: bytes) -> dict[str, Any]:
    """Columns of the first (``vertex``) element of a binary little-endian PLY."""
    end = data.find(b"end_header\n")
    if not data.startswith(b"ply\n") or end < 0:
        raise ValueError("not a PLY file")
    lines = data[:end].decode("ascii").splitlines()
    if "format binary_little_endian 1.0" not in lines:
        raise ValueError("PLY must be binary_little_endian")
    count, props, in_vertex = 0, [], False
    for line in lines:
        parts = line.split()
        if parts[:1] == ["element"]:
            if in_vertex:
                break
            in_vertex = parts[1] == "vertex"
            count = int(parts[2]) if in_vertex else 0
        elif parts[:1] == ["property"] and in_vertex:
            if parts[1] not in _PLY_TYPES:
                raise ValueError(f"unsupported PLY property type {parts[1]!r}")
            props.append((parts[2], _PLY_TYPES[parts[1]]))
    if not props:
        raise ValueError("PLY has no vertex element")
    arr = np.frombuffer(data, dtype=np.dtype(props), count=count, offset=end + len(b"end_header\n"))
    return {name: arr[name] for name, _ in props}


def _free_comfy_vram(transport: AgentTransport, task_id: TaskId) -> None:
    """SHARP needs ~7 GiB; ask a co-resident ComfyUI to drop its models first."""
    url = comfyui_url()
    try:
        requests.post(f"{url}/free", json={"unload_models": True, "free_memory": True}, timeout=5)
        report_progress(transport, f"Asked ComfyUI at {url} to unload models", "loading", task_id)
    except requests.RequestException:
        pass  # no ComfyUI running: nothing to free


def _clean_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("UV_", "PYTHON")) and k != "VIRTUAL_ENV"}
    env["PYTHONUTF8"] = "1"
    return env


def _tail(text: str, n: int = 12) -> str:
    return "\n".join(text.strip().splitlines()[-n:])


def execute_world_sharp(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
    job_timeout: int = 900,
) -> bool:
    """Execute a ``world.sharp`` task. Payload: ``input_image`` (+ optional ``hfov``)."""
    try:
        if capability != CAPABILITY:
            raise ValueError(f"Unsupported capability '{capability}' (expected {CAPABILITY})")
        if not output_bucket:
            raise ValueError("world.sharp tasks require an 'output_bucket' — the PLY is uploaded there")
        if not isinstance(payload, dict):
            raise ValueError(f"Payload must be a dict, got {type(payload).__name__}")
        if payload.get("mode") == "pano":
            raise ValueError("world.sharp handles perspective pictures only; use world.splat for 360° panoramas")

        paths = rt.SharpPaths.from_settings()
        st = rt.status(paths)
        if not st.ready:
            raise RuntimeError(st.describe())

        src_path = _input_path(payload, data_path)
        source_bytes = src_path.read_bytes()
        with Image.open(src_path) as im:
            source = ImageOps.exif_transpose(im)
            sw, sh = source.size
        hfov = _num(payload, "hfov", 0.0, 20.0, 120.0) if payload.get("hfov") not in (None, "") else 0.0

        _free_comfy_vram(transport, task_id)
        runner = data_path / "omq_sharp_runner.py"
        runner.write_text(RUNNER_SOURCE, encoding="utf-8")
        out_dir = data_path / "sharp_out"
        cmd = [str(paths.python), str(runner), "--image", str(src_path), "--out-dir", str(out_dir),
               "--checkpoint", str(paths.checkpoint)]
        if hfov:
            cmd += ["--hfov", f"{hfov:g}"]
        report_progress(transport, f"SHARP on {sw}x{sh} ({'hfov %g°' % hfov if hfov else 'focal from EXIF / 30 mm'})",
                        "predicting", task_id)

        started = time.monotonic()
        last = [started]

        def tick() -> None:
            now = time.monotonic()
            if now - started > job_timeout:
                raise TimeoutError(f"SHARP exceeded {job_timeout}s")
            if now - last[0] >= PROGRESS_EVERY_S:  # also the cancellation check (499 → TaskCancelled)
                last[0] = now
                report_progress(transport, None, "predicting", task_id)

        proc: dict[str, Any] = {}
        code = run_process(cmd, data_path, _clean_env(), b"", tick, proc)
        if code != 0:
            raise RuntimeError(f"SHARP exited with {code}:\n{_tail(proc.get('stderr') or proc.get('stdout', ''))}")
        meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
        ply = (out_dir / "scene.ply").read_bytes()

        t0 = time.monotonic()
        cols = read_vertex_ply(ply)
        xyz = np.stack([cols["x"], cols["y"], cols["z"]], 1).astype(np.float32)
        rgb = np.clip(np.stack([cols["f_dc_0"], cols["f_dc_1"], cols["f_dc_2"]], 1) * SH_C0 + 0.5, 0, 1)
        opacity = 1 / (1 + np.exp(-cols["opacity"].astype(np.float32)))
        visible = opacity > 0.3  # the point preview ignores near-transparent Gaussians
        preview = render_preview_sheet(
            xyz[visible], rgb[visible], SplatSettings(mode="perspective", hfov=float(meta["hfov"])),
        )
        z = xyz[:, 2]
        depth_range = [float(np.percentile(z, 1)), float(np.percentile(z, 99))]
        preview_s = round(time.monotonic() - t0, 2)
        report_progress(
            transport,
            f"{len(xyz):,} Gaussians, {len(ply) / 2**20:.1f} MiB, hfov {meta['hfov']:.0f}°, "
            f"depth {depth_range[0]:.1f}..{depth_range[1]:.0f} m, peak VRAM {meta.get('peak_vram_gib')} GiB",
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
            "splat_count": int(len(xyz)),
            "splats_fg": int(len(xyz)),
            "splats_bg": 0,
            "depth_range_m": depth_range,
            "settings": {
                "hfov": round(float(meta["hfov"]), 2),
                "focal_px": round(float(meta["focal_px"]), 2),
                "focal_source": meta["focal_source"],
            },
            "source": {"width": sw, "height": sh, "sha256": hashlib.sha256(source_bytes).hexdigest()},
            "runtime": {
                "revision": st.manifest.get("revision"), "torch": meta.get("torch"),
                "device": meta.get("gpu") or meta.get("device"), "peak_vram_gib": meta.get("peak_vram_gib"),
            },
            "timings": {**meta.get("timings", {}), "preview_s": preview_s,
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
        logger.exception("world.sharp failed")
        report_progress(transport, log=f"Task failed: {e}", stage="failed", task_id=task_id)
        report = make_failure_report(task_id, capability, str(e))

    return report_result(transport, report)
