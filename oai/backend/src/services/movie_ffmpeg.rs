//! ffmpeg helpers specific to Movie Studio: pulling the last frame of a scene
//! clip (long-shot continuity) and concatenating finished scene clips into one
//! movie. Mirrors the temp-file + `std::process::Command` + cleanup shape of
//! `image_processing::thumbnail_from_video` — this module has no DB/network I/O.

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{error::AppError, services::image_processing};

fn temp_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Extract the last frame of a video clip as a JPEG, for use as the next
/// scene's `img2video` input in long-shot mode.
pub fn last_frame_jpeg(bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty video".into()));
    }

    let stamp = temp_stamp();
    let tmp = std::env::temp_dir();
    let input = tmp.join(format!("oai-movie-lastframe-in-{stamp}.bin"));
    let output = tmp.join(format!("oai-movie-lastframe-out-{stamp}.jpg"));

    std::fs::write(&input, bytes)
        .map_err(|e| AppError::Internal(format!("write temp video failed: {e}")))?;

    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-sseof", "-0.3", "-i"])
        .arg(input.as_os_str())
        .args(["-update", "1", "-q:v", "2", "-y"])
        .arg(output.as_os_str())
        .status()
        .map_err(|e| AppError::Internal(format!("ffmpeg spawn failed: {e}")));

    let _ = std::fs::remove_file(&input);

    let status = status?;
    if !status.success() {
        let _ = std::fs::remove_file(&output);
        return Err(AppError::Internal(
            "ffmpeg last-frame extraction failed".into(),
        ));
    }

    let frame = std::fs::read(&output).map_err(|e| {
        let _ = std::fs::remove_file(&output);
        AppError::Internal(format!("read ffmpeg last frame failed: {e}"))
    })?;
    let _ = std::fs::remove_file(&output);

    if !image_processing::is_jpeg_blob(&frame, "image/jpeg") {
        return Err(AppError::Internal(
            "ffmpeg did not produce a valid JPEG last frame".into(),
        ));
    }
    Ok(frame)
}

/// Concatenate scene clips (in order) into a single movie file. Re-encodes
/// rather than stream-copying, since clips come from separate ComfyUI runs and
/// are not guaranteed to share compatible codec parameters.
pub fn concat_videos(clips: &[Vec<u8>]) -> Result<Vec<u8>, AppError> {
    if clips.is_empty() {
        return Err(AppError::BadRequest("no clips to concatenate".into()));
    }

    let stamp = temp_stamp();
    let dir = std::env::temp_dir().join(format!("oai-movie-concat-{stamp}"));
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Internal(format!("create temp dir failed: {e}")))?;

    let result = concat_videos_in_dir(clips, &dir);
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn concat_videos_in_dir(clips: &[Vec<u8>], dir: &std::path::Path) -> Result<Vec<u8>, AppError> {
    let mut list_lines = Vec::with_capacity(clips.len());
    for (idx, clip) in clips.iter().enumerate() {
        let path = dir.join(format!("clip-{idx:04}.mp4"));
        std::fs::write(&path, clip)
            .map_err(|e| AppError::Internal(format!("write temp clip failed: {e}")))?;
        // ffmpeg concat demuxer list format: single-quoted paths, no other escaping.
        list_lines.push(format!("file '{}'", path.display()));
    }
    let list_path = dir.join("list.txt");
    std::fs::write(&list_path, list_lines.join("\n"))
        .map_err(|e| AppError::Internal(format!("write concat list failed: {e}")))?;

    let output = dir.join("movie.mp4");
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"])
        .arg(list_path.as_os_str())
        .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y"])
        .arg(output.as_os_str())
        .status()
        .map_err(|e| AppError::Internal(format!("ffmpeg spawn failed: {e}")))?;

    if !status.success() {
        return Err(AppError::Internal("ffmpeg concat failed".into()));
    }

    let bytes = std::fs::read(&output)
        .map_err(|e| AppError::Internal(format!("read concatenated movie failed: {e}")))?;
    if bytes.is_empty() {
        return Err(AppError::Internal("ffmpeg produced an empty movie file".into()));
    }
    Ok(bytes)
}
