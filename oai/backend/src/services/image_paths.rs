//! Canonical OpenDAL paths for user image blobs.

/// Full-size stored image (always `.jpg` after processing).
pub fn main_image_path(user_id: i64, direction: &str, job_id: Option<i64>, image_id: i64) -> String {
    match direction {
        "output" if job_id.is_some() => {
            format!(
                "users/{user_id}/images/output/{}/{}.jpg",
                job_id.expect("output image requires job_id"),
                image_id
            )
        }
        _ => format!("users/{user_id}/images/input/{image_id}.jpg"),
    }
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
