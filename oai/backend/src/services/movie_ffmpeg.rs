//! ffmpeg helpers specific to Movie Studio: pulling the last frame of a scene
//! clip (long-shot continuity) and concatenating finished scene clips into one
//! movie. Shares the temp-file / gated-subprocess plumbing in [`super::subprocess`]
//! with `image_processing::thumbnail_from_video` — this module has no DB/network I/O.
//!
//! The public functions are async and run the blocking ffmpeg work on the blocking
//! pool; ffmpeg can take minutes on a concat and must never sit on an async worker.

use std::process::Command;

use crate::{
    error::AppError,
    services::{
        image_processing,
        subprocess::{TempDir, TempFile, blocking, run_gated},
    },
};

/// Extract the last frame of a video clip as a JPEG, for use as the next
/// scene's `img2video` input in long-shot mode.
pub async fn last_frame_jpeg(bytes: Vec<u8>) -> Result<Vec<u8>, AppError> {
    blocking(move || last_frame_jpeg_blocking(&bytes)).await
}

/// Concatenate scene clips (in order) into a single movie file. Re-encodes
/// rather than stream-copying, since clips come from separate ComfyUI runs and
/// are not guaranteed to share compatible codec parameters.
pub async fn concat_videos(clips: Vec<Vec<u8>>) -> Result<Vec<u8>, AppError> {
    blocking(move || concat_videos_blocking(&clips)).await
}

fn last_frame_jpeg_blocking(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty video".into()));
    }

    // Both files are removed on drop, on every exit path.
    let input = TempFile::write(bytes, ".bin")?;
    let output = TempFile::new(".jpg");

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-sseof", "-0.3", "-i"])
        .arg(&input.0)
        .args(["-update", "1", "-q:v", "2", "-y"])
        .arg(&output.0);
    run_gated(cmd)?;

    let frame = std::fs::read(&output.0)
        .map_err(|e| AppError::Internal(format!("read ffmpeg last frame failed: {e}")))?;

    if !image_processing::is_jpeg_blob(&frame, "image/jpeg") {
        return Err(AppError::Internal(
            "ffmpeg did not produce a valid JPEG last frame".into(),
        ));
    }
    Ok(frame)
}

fn concat_videos_blocking(clips: &[Vec<u8>]) -> Result<Vec<u8>, AppError> {
    if clips.is_empty() {
        return Err(AppError::BadRequest("no clips to concatenate".into()));
    }

    let dir = TempDir::new()?;

    let mut list_lines = Vec::with_capacity(clips.len());
    for (idx, clip) in clips.iter().enumerate() {
        let path = dir.path().join(format!("clip-{idx:04}.mp4"));
        std::fs::write(&path, clip)
            .map_err(|e| AppError::Internal(format!("write temp clip failed: {e}")))?;
        // ffmpeg concat demuxer list format: single-quoted paths, no other escaping.
        list_lines.push(format!("file '{}'", path.display()));
    }
    let list_path = dir.path().join("list.txt");
    std::fs::write(&list_path, list_lines.join("\n"))
        .map_err(|e| AppError::Internal(format!("write concat list failed: {e}")))?;

    let output = dir.path().join("movie.mp4");
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
    ])
    .arg(&list_path)
    .args([
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-y",
    ])
    .arg(&output);
    run_gated(cmd)?;

    let bytes = std::fs::read(&output)
        .map_err(|e| AppError::Internal(format!("read concatenated movie failed: {e}")))?;
    if bytes.is_empty() {
        return Err(AppError::Internal(
            "ffmpeg produced an empty movie file".into(),
        ));
    }
    Ok(bytes)
}
