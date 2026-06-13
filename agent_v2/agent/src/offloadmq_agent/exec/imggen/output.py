"""Output collection and upload for completed ComfyUI jobs.

Downloads output files from ComfyUI and uploads them to the agent's
output bucket on the offload server.
"""

from typing import Any

from offloadmq_agent.transport_exec import AgentTransport
from .comfyui import download_file

_VIDEO_TASK_TYPES = {"txt2video", "img2video"}


def upload_output_file(
    transport: AgentTransport, bucket_uid: str, filename: str, content: bytes, content_type: str
) -> str:
    """Upload an output file to the server bucket. Returns the file_uid assigned by the server."""
    return transport.upload_file(bucket_uid, filename, content, content_type)


def collect_images(history_entry: dict[str, Any], transport: AgentTransport, bucket_uid: str) -> list[dict[str, Any]]:
    """Download all output images from a history entry and upload them to the bucket."""
    images = []
    for node_output in history_entry.get("outputs", {}).values():
        for img in node_output.get("images", []):
            filename = img.get("filename", "")
            content, ct = download_file(filename, img.get("subfolder", ""), img.get("type", "output"))
            file_uid = upload_output_file(transport, bucket_uid, filename, content, ct)
            images.append({
                "filename":     filename,
                "content_type": ct,
                "file_uid":     file_uid,
                "bucket_uid":   bucket_uid,
            })
    return images


# Output keys ComfyUI uses for video, in preference order:
#   "videos" — native SaveVideo / SaveWEBM (ui.PreviewVideo)
#   "gifs"   — VideoHelperSuite VHS_VideoCombine (mp4/webm/gif all land here)
#   "images" — SaveAnimatedWEBP / SaveAnimatedPNG (animated frames saved as a
#              single file under the regular image key)
# Video/gif keys are preferred across all nodes before falling back to images,
# so a preview-image node can't shadow the real video output.
_VIDEO_OUTPUT_KEYS = ("videos", "gifs", "images")


def collect_video(history_entry: dict[str, Any], transport: AgentTransport, bucket_uid: str) -> dict[str, Any] | None:
    """Download the first output video from a history entry and upload it to the bucket.

    Scans every output node for each known video key in preference order, so an
    animated file emitted under the generic "images" key (SaveAnimatedWEBP/PNG)
    is still recognised as the video result.
    """
    outputs = history_entry.get("outputs", {}).values()
    for key in _VIDEO_OUTPUT_KEYS:
        for node_output in outputs:
            for vid in node_output.get(key, []):
                filename = vid.get("filename", "")
                content, ct = download_file(filename, vid.get("subfolder", ""), vid.get("type", "output"))
                file_uid = upload_output_file(transport, bucket_uid, filename, content, ct)
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
) -> dict[str, Any]:
    """Collect all outputs from a completed ComfyUI job and return a result dict."""
    base: dict[str, str | int] = {"workflow": task_type, "prompt_id": prompt_id, "output_bucket": bucket_uid}
    if seed is not None:
        base["seed"] = seed

    if task_type in _VIDEO_TASK_TYPES:
        video = collect_video(history_entry, transport, bucket_uid)
        if not video:
            raise ValueError("ComfyUI completed but returned no video output")
        frame_count = 0
        for node_output in history_entry.get("outputs", {}).values():
            frame_count = len(node_output.get("images", [])) or frame_count
        return {**base, "frame_count": frame_count, "video": video}

    images = collect_images(history_entry, transport, bucket_uid)
    if not images:
        raise ValueError("ComfyUI completed but returned no output images")
    return {**base, "image_count": len(images), "images": images}
