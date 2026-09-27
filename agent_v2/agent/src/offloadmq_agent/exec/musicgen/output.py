"""Output collection for completed ComfyUI music generation jobs.

Downloads audio files from ComfyUI and uploads them to the agent's
output bucket on the offload server. Mirrors :mod:`offloadmq_agent.exec.imggen.output`
(same diagnostic-logging pattern via ``log_progress``/``describe_outputs``) so a
music job that returns no audio is exactly as diagnosable as an equivalent
imggen failure.
"""

from typing import Any

from offloadmq_agent.wire import TaskId
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.exec.imggen.comfyui import download_file
from offloadmq_agent.exec.imggen.output import describe_outputs, log_progress


def upload_output_file(
    transport: AgentTransport, bucket_uid: str, filename: str, content: bytes, content_type: str,
    task_id: TaskId | None = None,
) -> str:
    """Upload an output file to the server bucket. Returns the file_uid assigned by the server."""
    file_uid = transport.upload_file(bucket_uid, filename, content, content_type)
    log_progress(
        transport, task_id,
        f"Uploaded '{filename}' ({len(content)} bytes, {content_type}) "
        f"to bucket {bucket_uid} → file_uid={file_uid}",
    )
    return file_uid


def collect_audio(
    history_entry: dict[str, Any], transport: AgentTransport, bucket_uid: str,
    task_id: TaskId | None = None,
) -> list[dict[str, Any]]:
    """Download all output audio files from a history entry and upload them to the bucket."""
    audio_files = []
    for node_id, node_output in history_entry.get("outputs", {}).items():
        for audio in node_output.get("audio", []):
            filename = audio.get("filename", "")
            log_progress(
                transport, task_id,
                f"Collecting audio from node {node_id}: filename='{filename}' "
                f"subfolder='{audio.get('subfolder', '')}' type='{audio.get('type', 'output')}'",
            )
            content, ct = download_file(filename, audio.get("subfolder", ""), audio.get("type", "output"))
            file_uid = upload_output_file(transport, bucket_uid, filename, content, ct, task_id)
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
    task_id: TaskId | None = None,
) -> dict[str, Any]:
    """Collect all audio outputs from a completed ComfyUI job and return a result dict."""
    # Always surface exactly what ComfyUI handed back, so a "no output" failure
    # is diagnosable from the task log alone (same as imggen's build_output).
    log_progress(transport, task_id, describe_outputs(history_entry))

    base: dict[str, Any] = {"workflow": task_type, "prompt_id": prompt_id, "output_bucket": bucket_uid}
    if seed is not None:
        base["seed"] = seed

    audio_files = collect_audio(history_entry, transport, bucket_uid, task_id)
    if not audio_files:
        log_progress(
            transport, task_id,
            f"No audio found across {len(history_entry.get('outputs', {}))} output node(s).",
            stage="failed",
        )
        raise ValueError("ComfyUI completed but returned no audio output")
    log_progress(transport, task_id, f"Collected {len(audio_files)} audio file(s)")
    return {**base, "audio_count": len(audio_files), "audio": audio_files}
