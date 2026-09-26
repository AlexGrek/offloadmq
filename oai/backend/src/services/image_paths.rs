//! Canonical OpenDAL paths for user image blobs.

/// Which slot a full-size image occupies. An output always belongs to a job, so the
/// job id lives in the variant: "output without a job" is unrepresentable rather than
/// a runtime panic, and a mistyped direction string can't silently become `Input`.
#[derive(Debug, Clone, Copy)]
pub enum MainImage {
    Input,
    Output { job_id: i64 },
}

/// Full-size stored image (always `.jpg` after processing).
pub fn main_image_path(user_id: i64, kind: MainImage, image_id: i64) -> String {
    match kind {
        MainImage::Input => format!("users/{user_id}/images/input/{image_id}.jpg"),
        MainImage::Output { job_id } => {
            format!("users/{user_id}/images/output/{job_id}/{image_id}.jpg")
        }
    }
}

/// Output image produced by a feature that has no `image_generation_jobs` row of
/// its own (e.g. `img-utils` transforms), so `main_image_path` has no job id to
/// nest under.
pub fn standalone_output_path(user_id: i64, image_id: i64) -> String {
    format!("users/{user_id}/images/output/standalone/{image_id}.jpg")
}

/// Raw video output path — preserves the agent-reported filename extension (e.g. `.mp4`).
pub fn video_output_path(user_id: i64, job_id: i64, file_id: i64, filename: &str) -> String {
    let ext = filename
        .rsplit_once('.')
        .map(|(_, e)| e)
        .filter(|e| !e.is_empty())
        .unwrap_or("mp4");
    format!("users/{user_id}/videos/output/{job_id}/{file_id}.{ext}")
}

/// Thumbnail directory — one JPEG per image id, deleted with the main file.
pub fn thumbnail_path(user_id: i64, image_id: i64) -> String {
    format!("users/{user_id}/images/thumbnails/{image_id}.jpg")
}

/// User favorites — copy of the main JPEG; presence indicates starred (no DB column).
pub fn starred_image_path(user_id: i64, image_id: i64) -> String {
    format!("users/{user_id}/images/starred/{image_id}.jpg")
}

/// Assembled Movie Studio output — always `.mp4` (ffmpeg concat re-encode).
pub fn movie_output_path(user_id: i64, job_id: i64, file_id: i64) -> String {
    format!("users/{user_id}/videos/movies/{job_id}/{file_id}.mp4")
}

/// Saved-prompt preview thumbnail. Keyed by the prompt *content* (not the entry id) so
/// a recent and a starred entry with the same text share one blob — starring a recent
/// keeps its preview without copying anything. `bucket` is already validated by
/// `db::prompts::normalize_bucket` (`[A-Za-z0-9._-]`), so it is path-safe.
pub fn prompt_preview_path(user_id: i64, bucket: &str, content: &str) -> String {
    let digest = super::image_processing::sha256_hex(content.as_bytes());
    format!("users/{user_id}/prompt_previews/{bucket}/{digest}.jpg")
}

#[cfg(test)]
mod tests {
    use super::*;

    // These strings are persisted in `image_files.storage_path` — changing them
    // orphans every existing blob, so they are pinned here.
    #[test]
    fn stored_path_formats_are_stable() {
        assert_eq!(main_image_path(7, MainImage::Input, 99), "users/7/images/input/99.jpg");
        assert_eq!(
            main_image_path(7, MainImage::Output { job_id: 5 }, 99),
            "users/7/images/output/5/99.jpg"
        );
        assert_eq!(standalone_output_path(7, 99), "users/7/images/output/standalone/99.jpg");
        assert_eq!(thumbnail_path(7, 99), "users/7/images/thumbnails/99.jpg");
        assert_eq!(starred_image_path(7, 99), "users/7/images/starred/99.jpg");
        assert_eq!(video_output_path(7, 5, 99, "clip.webm"), "users/7/videos/output/5/99.webm");
        assert_eq!(video_output_path(7, 5, 99, "noext"), "users/7/videos/output/5/99.mp4");
        assert_eq!(movie_output_path(7, 5, 99), "users/7/videos/movies/5/99.mp4");
    }
}
