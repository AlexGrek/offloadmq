"""Output collection for completed ComfyUI music generation jobs.

Downloads audio files from ComfyUI and uploads them to the agent's
output bucket on the offload server.
"""

from typing import Any

from ...transport import AgentTransport
from ..imggen.comfyui import download_file


def upload_output_file(
    transport: AgentTransport, bucket_uid: str, filename: str, content: bytes, content_type: str
) -> str:
    """Upload an output file to the server bucket. Returns the file_uid assigned by the server."""
    return transport.upload_file(bucket_uid, filename, content, content_type)


def collect_audio(
    history_entry: dict[str, Any], transport: AgentTransport, bucket_uid: str
) -> list[dict[str, Any]]:
    """Download all output audio files from a history entry and upload them to the bucket."""
    audio_files = []
    for node_output in history_entry.get("outputs", {}).values():
        for audio in node_output.get("audio", []):
            filename = audio.get("filename", "")
            content, ct = download_file(filename, audio.get("subfolder", ""), audio.get("type", "output"))
            file_uid = upload_output_file(transport, bucket_uid, filename, content, ct)
            audio_files.append({
                "filename":     filename,
                "content_type": ct,
                "file_uid":     file_uid,
                "bucket_uid":   bucket_uid,
            })
    return audio_files


def build_output(
    history_entry: dict[str, Any],
    task_type: str,
    prompt_id: str,
    seed: int | None,
    transport: AgentTransport,
    bucket_uid: str,
) -> dict[str, Any]:
    """Collect all audio outputs from a completed ComfyUI job and return a result dict."""
    base: dict[str, Any] = {"workflow": task_type, "prompt_id": prompt_id, "output_bucket": bucket_uid}
    if seed is not None:
        base["seed"] = seed

    audio_files = collect_audio(history_entry, transport, bucket_uid)
    if not audio_files:
        raise ValueError("ComfyUI completed but returned no audio output")
    return {**base, "audio_count": len(audio_files), "audio": audio_files}
