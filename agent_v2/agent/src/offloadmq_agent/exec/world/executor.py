"""``world.splat`` executor — one image in, an explorable Gaussian-splat world out.

Pipeline: the input image (already downloaded from the task's input bucket) is
fitted to the splat budget, run through the installed ``img-utils`` *depth*
ComfyUI workflow (Lotus-D), converted to a 3DGS PLY by :mod:`.splat`, and the
PLY, a preview contact sheet and the depth map are uploaded to the output
bucket. See docs/agent-capabilities.md (``world.splat``) for the contract.
"""

from __future__ import annotations

import hashlib
import io
import logging
import time
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageOps

from offloadmq_agent.exec.imggen import workflow as wf
from offloadmq_agent.exec.imggen.comfyui import download_file, queue_prompt, wait_for_completion
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

from .splat import SplatSettings, build_world, resolve_mode

logger = logging.getLogger("agent")

PREFIX = "world."
CAPABILITY = "world.splat"
GENERATOR = "lotus-ldi-v1"
DEPTH_NAMESPACE = "img-utils"
DEPTH_TASK_TYPE = "depth"
MAX_WIDTH_LIMIT = 2048


def find_depth_pack(workflows_dir: Path | None = None) -> str | None:
    """The img-utils pack providing a ``depth`` operation (``depth`` preferred).

    Pack names follow the model (``image_lotus_depth_v1_1``) on real installs and
    the operation (``depth``) in the repo's reference copy, so neither is assumed.
    """
    root = (workflows_dir or wf.WORKFLOWS_DIR) / DEPTH_NAMESPACE
    try:
        packs = sorted(p.name for p in root.iterdir() if p.is_dir())
    except OSError:
        return None
    candidates = [
        p for p in packs
        if (root / p / f"{DEPTH_TASK_TYPE}.json").is_file()
        and (root / p / f"{DEPTH_TASK_TYPE}.params.json").is_file()
    ]
    if not candidates:
        return None
    return DEPTH_TASK_TYPE if DEPTH_TASK_TYPE in candidates else candidates[0]


def _num(payload: dict[str, Any], key: str, default: float, lo: float, hi: float) -> float:
    raw = payload.get(key)
    if raw is None or raw == "":
        return default
    try:
        val = float(raw)
    except (TypeError, ValueError) as e:
        raise ValueError(f"'{key}' must be a number, got {raw!r}") from e
    if val != val:  # NaN
        raise ValueError(f"'{key}' must be a number, got NaN")
    return min(max(val, lo), hi)


def parse_settings(payload: dict[str, Any], width: int, height: int) -> SplatSettings:
    near = _num(payload, "near", 1.2, 0.1, 20.0)
    far = _num(payload, "far", 50.0, near + 0.5, 1000.0)
    return SplatSettings(
        mode=resolve_mode(width, height, payload.get("mode")),
        hfov=_num(payload, "hfov", 70.0, 20.0, 150.0),
        near=near,
        far=far,
        fill_lean=_num(payload, "fill_lean", 0.25, 0.0, 1.0),
        max_width=int(_num(payload, "max_width", 1024, 256, MAX_WIDTH_LIMIT)),
    )


def _input_path(payload: dict[str, Any], data_path: Path) -> Path:
    name = payload.get("input_image")
    if not name or not isinstance(name, str):
        raise ValueError("Payload missing required 'input_image' (a file name from the input bucket)")
    path = (data_path / name).resolve()
    try:
        path.relative_to(data_path.resolve())
    except ValueError as e:
        raise ValueError(f"'input_image' escapes the task data directory: {name!r}") from e
    if not path.is_file():
        raise FileNotFoundError(f"File '{name}' not found in task data directory (field: input_image)")
    return path


def _first_output_image(history_entry: dict[str, Any]) -> tuple[str, str, str]:
    for node_output in history_entry.get("outputs", {}).values():
        if not isinstance(node_output, dict):
            continue
        for item in node_output.get("images", []) or []:
            if isinstance(item, dict) and item.get("filename") and item.get("type", "output") == "output":
                return str(item["filename"]), str(item.get("subfolder", "")), str(item.get("type", "output"))
    raise RuntimeError("Depth workflow produced no output image")


def _run_depth(transport: AgentTransport, task_id: TaskId, image_name: str, data_path: Path,
               job_timeout: int) -> tuple[Image.Image, str]:
    pack = find_depth_pack()
    if pack is None:
        raise FileNotFoundError(
            f"No img-utils depth workflow installed — copy agent_v2/workflows/img-utils/depth/ "
            f"into {wf.WORKFLOWS_DIR / DEPTH_NAMESPACE}"
        )
    graph, param_map = wf.load_workflow_template(pack, DEPTH_TASK_TYPE, namespace=DEPTH_NAMESPACE)
    values = wf.build_injection_values({"input_image": image_name}, DEPTH_TASK_TYPE, data_path)
    graph = wf.inject_params(graph, param_map, values)
    prompt_id = queue_prompt(graph, transport, task_id)
    report_progress(transport, f"Depth ({DEPTH_NAMESPACE}.{pack}) queued as prompt_id={prompt_id}",
                    "depth", task_id)
    entry = wait_for_completion(prompt_id, transport, task_id, job_timeout)
    content, _ = download_file(*_first_output_image(entry))
    return Image.open(io.BytesIO(content)).copy(), prompt_id


def _file_ref(name: str, content_type: str, content: bytes, file_uid: str, bucket: str) -> dict[str, Any]:
    return {
        "filename": name, "content_type": content_type, "file_uid": file_uid, "bucket_uid": bucket,
        "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
    }


def execute_world_splat(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data_path: Path,
    output_bucket: str | None = None,
    job_timeout: int = 600,
) -> bool:
    """Execute a ``world.splat`` task. Payload: see docs/agent-capabilities.md."""
    try:
        if capability != CAPABILITY:
            raise ValueError(f"Unsupported capability '{capability}' (expected {CAPABILITY})")
        if not output_bucket:
            raise ValueError("world.splat tasks require an 'output_bucket' — the PLY is uploaded there")
        if not isinstance(payload, dict):
            raise ValueError(f"Payload must be a dict, got {type(payload).__name__}")

        timings: dict[str, float] = {}
        src_path = _input_path(payload, data_path)
        source_bytes = src_path.read_bytes()
        source = ImageOps.exif_transpose(Image.open(io.BytesIO(source_bytes))).convert("RGB")
        settings = parse_settings(payload, source.width, source.height)

        # Depth runs on the splat-sized image: Lotus is resolution-agnostic and a
        # 4k upload would only make ComfyUI slower for pixels the splat drops anyway.
        work = source
        if source.width > settings.max_width:
            work = source.resize(
                (settings.max_width, round(source.height * settings.max_width / source.width)),
                Image.Resampling.LANCZOS,
            )
        work_name = "world_source.png"
        work.save(data_path / work_name, format="PNG")
        report_progress(
            transport,
            f"Source {source.width}x{source.height} → {work.width}x{work.height}, mode={settings.mode}",
            "depth", task_id,
        )

        t0 = time.monotonic()
        depth, prompt_id = _run_depth(transport, task_id, work_name, data_path, job_timeout)
        timings["depth_s"] = round(time.monotonic() - t0, 2)

        report_progress(transport, "Building Gaussian splat", "splatting", task_id)
        t0 = time.monotonic()
        world = build_world(work, depth, settings)
        timings["splat_s"] = round(time.monotonic() - t0, 2)
        report_progress(
            transport,
            f"{world.splat_count:,} splats ({world.splats_bg:,} hidden background), "
            f"{len(world.ply) / 2**20:.1f} MiB, depth {world.depth_min:.2f}..{world.depth_max:.2f} m",
            "uploading", task_id,
        )

        t0 = time.monotonic()
        depth_buf = io.BytesIO()
        depth.convert("L").save(depth_buf, format="PNG")
        files: dict[str, dict[str, Any]] = {}
        for key, name, ctype, content in (
            ("ply", "scene.ply", "application/octet-stream", world.ply),
            ("preview", "preview.png", "image/png", world.preview_png),
            ("depth", "depth.png", "image/png", depth_buf.getvalue()),
        ):
            uid = upload_output_file(transport, output_bucket, name, content, ctype, task_id)
            files[key] = _file_ref(name, ctype, content, uid, output_bucket)
        timings["upload_s"] = round(time.monotonic() - t0, 2)

        output: dict[str, Any] = {
            "output_bucket": output_bucket,
            "generator": GENERATOR,
            "mode": settings.mode,
            "splat_count": world.splat_count,
            "splats_fg": world.splats_fg,
            "splats_bg": world.splats_bg,
            "grid": {"width": world.grid_width, "height": world.grid_height},
            "depth_range_m": [world.depth_min, world.depth_max],
            "settings": {
                "mode": settings.mode, "hfov": settings.hfov, "near": settings.near, "far": settings.far,
                "fill_lean": settings.fill_lean, "max_width": settings.max_width,
            },
            "source": {
                "width": source.width, "height": source.height,
                "sha256": hashlib.sha256(source_bytes).hexdigest(),
            },
            "prompt_id": prompt_id,
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
        logger.exception("world.splat failed")
        report_progress(transport, log=f"Task failed: {e}", stage="failed", task_id=task_id)
        report = make_failure_report(task_id, capability, str(e))

    return report_result(transport, report)
