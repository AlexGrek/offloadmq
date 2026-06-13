"""Output collection and upload for completed ComfyUI jobs.

Downloads output files from ComfyUI and uploads them to the agent's
output bucket on the offload server.
"""

import json
import logging
from typing import Any

from offloadmq_agent.wire import TaskId
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.exec.reporting import report_progress
from .comfyui import download_file

logger = logging.getLogger("agent")

_VIDEO_TASK_TYPES = {"txt2video", "img2video"}

# Output keys ComfyUI uses for video, in preference order:
#   "videos" — native SaveVideo / SaveWEBM (ui.PreviewVideo)
#   "gifs"   — VideoHelperSuite VHS_VideoCombine (mp4/webm/gif all land here)
#   "images" — SaveAnimatedWEBP / SaveAnimatedPNG (animated frames saved as a
#              single file under the regular image key), AND workflows that emit
#              mp4/webm directly into the images key (e.g. WAN 2.1 img2video)
# Video/gif keys are preferred across all nodes before falling back to images,
# so a preview-image node can't shadow the real video output.
_VIDEO_OUTPUT_KEYS = ("videos", "gifs", "images")

# Extensions treated as video/animation when scanning the generic "images" key.
# Still-image formats (png, jpg, jpeg, …) are deliberately excluded so that
# temp preview frames don't shadow the real video output.
_VIDEO_EXTENSIONS = frozenset({".mp4", ".webm", ".gif", ".webp", ".avi", ".mov", ".mkv"})


def _has_video_extension(filename: str) -> bool:
    if "." not in filename:
        return False
    return f".{filename.rsplit('.', 1)[-1].lower()}" in _VIDEO_EXTENSIONS

# Per-output-entry fields worth surfacing in the task log (the raw entries can
# also carry a huge embedded "workflow" blob, which we deliberately skip).
_SALIENT_FIELDS = ("filename", "subfolder", "type", "format", "frame_rate")


def _log(transport: AgentTransport, task_id: TaskId | None, message: str, stage: str = "collecting") -> None:
    """Emit a log line both to the agent logger and (if known) the task's progress feed."""
    logger.info(message)
    if task_id is not None:
        report_progress(transport, log=message, stage=stage, task_id=task_id)


def describe_outputs(history_entry: dict[str, Any]) -> str:
    """Render a compact, human-readable summary of every output node ComfyUI produced.

    Lists each node id, the output key (images/gifs/videos/...), and the salient
    fields of each entry — exactly what's needed to see why a collector did or
    did not find a file, without dumping multi-kilobyte embedded workflow blobs.
    """
    outputs = history_entry.get("outputs", {})
    if not outputs:
        return "ComfyUI returned NO output nodes at all (history 'outputs' is empty)."

    lines: list[str] = [f"ComfyUI produced {len(outputs)} output node(s):"]
    for node_id, node_output in outputs.items():
        if not isinstance(node_output, dict) or not node_output:
            lines.append(f"  node {node_id}: (no output payload)")
            continue
        for key, items in node_output.items():
            if not isinstance(items, list):
                lines.append(f"  node {node_id} / {key}: {items!r}")
                continue
            lines.append(f"  node {node_id} / {key}: {len(items)} item(s)")
            for idx, item in enumerate(items):
                if isinstance(item, dict):
                    salient = {k: item[k] for k in _SALIENT_FIELDS if k in item}
                    lines.append(f"      [{idx}] {json.dumps(salient, default=str)}")
                else:
                    lines.append(f"      [{idx}] {item!r}")
    return "\n".join(lines)


def upload_output_file(
    transport: AgentTransport, bucket_uid: str, filename: str, content: bytes, content_type: str,
    task_id: TaskId | None = None,
) -> str:
    """Upload an output file to the server bucket. Returns the file_uid assigned by the server."""
    file_uid = transport.upload_file(bucket_uid, filename, content, content_type)
    _log(
        transport, task_id,
        f"Uploaded '{filename}' ({len(content)} bytes, {content_type}) "
        f"to bucket {bucket_uid} → file_uid={file_uid}",
    )
    return file_uid


def collect_images(
    history_entry: dict[str, Any], transport: AgentTransport, bucket_uid: str,
    task_id: TaskId | None = None,
) -> list[dict[str, Any]]:
    """Download all output images from a history entry and upload them to the bucket."""
    images = []
    for node_id, node_output in history_entry.get("outputs", {}).items():
        for img in node_output.get("images", []):
            filename = img.get("filename", "")
            _log(
                transport, task_id,
                f"Collecting image from node {node_id}: filename='{filename}' "
                f"subfolder='{img.get('subfolder', '')}' type='{img.get('type', 'output')}'",
            )
            content, ct = download_file(filename, img.get("subfolder", ""), img.get("type", "output"))
            file_uid = upload_output_file(transport, bucket_uid, filename, content, ct, task_id)
            images.append({
                "filename":     filename,
                "content_type": ct,
                "file_uid":     file_uid,
                "bucket_uid":   bucket_uid,
            })
    return images


def collect_video(
    history_entry: dict[str, Any], transport: AgentTransport, bucket_uid: str,
    task_id: TaskId | None = None,
) -> dict[str, Any] | None:
    """Download the first output video from a history entry and upload it to the bucket.

    Scans every output node for each known video key in preference order, so an
    animated file emitted under the generic "images" key (SaveAnimatedWEBP/PNG)
    is still recognised as the video result.
    """
    outputs = history_entry.get("outputs", {})
    for key in _VIDEO_OUTPUT_KEYS:
        for node_id, node_output in outputs.items():
            for vid in node_output.get(key, []):
                filename = vid.get("filename", "")
                # Under the generic "images" key, still-image files (png/jpg/…)
                # must be skipped — they are preview frames or temp outputs, not
                # the video result.  The dedicated "videos"/"gifs" keys are
                # always accepted regardless of extension.
                if key == "images" and not _has_video_extension(filename):
                    continue
                _log(
                    transport, task_id,
                    f"Found video candidate under '{key}' in node {node_id}: filename='{filename}' "
                    f"subfolder='{vid.get('subfolder', '')}' type='{vid.get('type', 'output')}' "
                    f"format='{vid.get('format', '')}'",
                )
                content, ct = download_file(filename, vid.get("subfolder", ""), vid.get("type", "output"))
                file_uid = upload_output_file(transport, bucket_uid, filename, content, ct, task_id)
                return {
                    "filename":     filename,
                    "content_type": ct,
                    "file_uid":     file_uid,
                    "bucket_uid":   bucket_uid,
                }
    return None


def build_output(
    history_entry: dict[str, Any],
    task_type: str,
    prompt_id: str,
    seed: int | None,
    transport: AgentTransport,
    bucket_uid: str,
    task_id: TaskId | None = None,
) -> dict[str, Any]:
    """Collect all outputs from a completed ComfyUI job and return a result dict."""
    # Always surface exactly what ComfyUI handed back, so a "no output" failure
    # is diagnosable from the task log alone.
    _log(transport, task_id, describe_outputs(history_entry))

    base: dict[str, str | int] = {"workflow": task_type, "prompt_id": prompt_id, "output_bucket": bucket_uid}
    if seed is not None:
        base["seed"] = seed

    if task_type in _VIDEO_TASK_TYPES:
        _log(transport, task_id, f"Task type '{task_type}' is a video workflow — collecting video output")
        video = collect_video(history_entry, transport, bucket_uid, task_id)
        if not video:
            _log(
                transport, task_id,
                f"No video found under any of {_VIDEO_OUTPUT_KEYS} across "
                f"{len(history_entry.get('outputs', {}))} output node(s).",
                stage="failed",
            )
            raise ValueError("ComfyUI completed but returned no video output")
        frame_count = 0
        for node_output in history_entry.get("outputs", {}).values():
            frame_count = len(node_output.get("images", [])) or frame_count
        _log(transport, task_id, f"Video output collected: {video['filename']} (frame_count={frame_count})")
        return {**base, "frame_count": frame_count, "video": video}

    _log(transport, task_id, f"Task type '{task_type}' is an image workflow — collecting image output")
    images = collect_images(history_entry, transport, bucket_uid, task_id)
    if not images:
        _log(
            transport, task_id,
            f"No images found under the 'images' key across "
            f"{len(history_entry.get('outputs', {}))} output node(s).",
            stage="failed",
        )
        raise ValueError("ComfyUI completed but returned no output images")
    _log(transport, task_id, f"Collected {len(images)} image(s)")
    return {**base, "image_count": len(images), "images": images}
