//! "External resize" — offloading the input-image downscale to an agent.
//!
//! # Why
//!
//! [`image_processing::process_image`] deliberately **bypasses** decode + resize
//! for JPEGs over `MAX_TRANSCODE_BYTES` (8 MB) or `MAX_TRANSCODE_EDGE` (6000 px):
//! pulling a 48 MP photo through libvips can exceed pod memory. Those uploads are
//! therefore stored *verbatim*, at full size — and every feature that stages the
//! stored image into an OffloadMQ bucket then ships the whole thing to whatever
//! agent runs the job, which for img2img/img2video/describe is the expensive one.
//!
//! External resize closes that gap without decoding anything locally: the raw
//! stored bytes go into a bucket, a cheap `image_resize` task shrinks them on any
//! online agent, and the *resize task's own output bucket* becomes the input
//! bucket of the real task. The result never round-trips through OAI.
//!
//! # Shape of the chain
//!
//! ```text
//! start_job(external_resize = true)
//!   → stage raw bytes → submit `image_resize`   ← job's offload task is the pre-step
//!   → poll … completed
//!   → promote: submit the real task with file_bucket = the resize output bucket
//!   → poll … completed → normal result handling
//! ```
//!
//! The job needs no "phase" column: the in-flight task **is** the pre-step exactly
//! when its capability is [`RESIZE_CAPABILITY`], which every caller already stores.
//!
//! Both consumers ([`crate::services::image_jobs`] and
//! [`crate::services::image_analysis`]) share the submit and extract helpers here;
//! the promote step is feature-specific and lives with each pipeline.

use crate::{
    db::image_generation::ImageFile,
    error::AppError,
    offload::image_tasks::{OffloadImageClient, OffloadTaskId},
    services::{image_processing::MAX_IMAGE_EDGE, img_utils, storage},
    state::AppState,
};

pub use crate::services::img_utils::RESIZE_CAPABILITY;

/// Uploads **above** this size get the checkbox ticked by default (the client
/// applies the comparison; this endpoint-published number is the source of truth). Sits just
/// above `MAX_TRANSCODE_BYTES` (8 MB), the point where local processing gives up
/// and stores the original untouched — so the default is on precisely for the
/// files that are still full-size in storage.
pub const EXTERNAL_RESIZE_THRESHOLD_BYTES: i64 = 9 * 1024 * 1024;

/// The resized file produced by a completed pre-step, ready to be handed to the
/// real task as its input bucket.
#[derive(Debug, Clone)]
pub struct ResizedInput {
    pub bucket_uid: String,
    pub filename: String,
}

/// True when the given capability is the resize pre-step rather than a real task.
pub fn is_pre_step(cap: &str) -> bool {
    crate::offload::base_capability(cap) == RESIZE_CAPABILITY
}

/// Whether any online agent advertises `image_resize`. Used by the UI to decide
/// whether to offer the checkbox at all.
pub async fn is_available(state: &AppState) -> bool {
    match img_utils::list_capabilities(state).await {
        Ok(caps) => caps.iter().any(|c| c.kind == img_utils::KIND_RESIZE),
        Err(e) => {
            tracing::warn!("external_resize: capability probe failed: {e}");
            false
        }
    }
}

/// A submitted resize pre-step, as far as the caller needs to record it.
pub struct PreStep {
    pub task_id: OffloadTaskId,
    /// Bucket the agent writes the resized image to — the input bucket of the
    /// real task once this one completes.
    pub output_bucket: String,
    /// The submitted request body, stored verbatim like any other task so the
    /// debug view and the promote step can read it back.
    pub submit_payload: serde_json::Value,
}

/// Stage `input`'s stored bytes and submit the resize pre-step.
///
/// The bytes are uploaded **exactly as stored** — decoding them here is the cost
/// this whole path exists to avoid.
pub async fn submit(
    state: &AppState,
    client: &OffloadImageClient,
    input: &ImageFile,
) -> Result<PreStep, AppError> {
    let bytes = storage::read(storage::operator(state)?, &input.storage_path).await?;

    let in_bucket = client.create_bucket(true).await?;
    // The agent matches bucket files by name, and the payload references this one.
    let filename = staged_filename(input);
    client
        .upload_bucket_file(&in_bucket.bucket_uid, bytes, &filename, &input.content_type)
        .await?;

    let out_bucket = client.create_bucket(false).await?;
    let (task_id, submit_payload) = client
        .submit_img_task(
            RESIZE_CAPABILITY,
            payload(&filename),
            Some(&in_bucket.bucket_uid),
            &out_bucket.bucket_uid,
            None,
        )
        .await?;
    Ok(PreStep { task_id, output_bucket: out_bucket.bucket_uid, submit_payload })
}

/// The output bucket recorded when the pre-step was submitted, recovered from
/// the stored request body. Used as a fallback when the agent's own output does
/// not echo the bucket back.
pub fn bucket_from_submit_payload(raw: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()?
        .get("output_bucket")?
        .as_str()
        .map(ToOwned::to_owned)
}

/// Name the staged copy after the stored file, with an extension the agent will
/// recognise. Stored images are JPEG unless they were kept verbatim, and those
/// are JPEG too (only JPEG takes the verbatim path).
fn staged_filename(input: &ImageFile) -> String {
    let stem = input
        .filename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(&input.filename);
    let ext = if input.content_type == "image/png" { "png" } else { "jpg" };
    format!("resize_input_{}.{ext}", sanitize(stem))
}

fn sanitize(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // Keep it short: the name only has to be unique inside a single-file bucket.
    cleaned.chars().take(48).collect()
}

/// Normalize to the platform's stored-image limit — the same box
/// `process_image` would have used locally, so downstream behaviour is unchanged.
/// Never enlarges: an image that already fits is passed through re-encoded only.
fn payload(filename: &str) -> serde_json::Value {
    serde_json::json!({
        "input_image": filename,
        "mode": "fit",
        "width": MAX_IMAGE_EDGE,
        "height": MAX_IMAGE_EDGE,
        "allow_upscale": false,
        "method": "lanczos",
        "format": "jpeg",
        "quality": 90,
    })
}

/// Pull the resized file out of a completed `image_resize` poll output.
///
/// `fallback_bucket` is the bucket the caller created at submit time; the agent
/// echoes it back as `output_bucket`, but a task replayed by an older agent may
/// not, so the caller's own value wins nothing and is used only if absent.
pub fn completed_output(
    output: Option<&serde_json::Value>,
    fallback_bucket: Option<&str>,
) -> Option<ResizedInput> {
    let output = output?;
    let image = output.get("images")?.as_array()?.last()?;
    let filename = image.get("filename")?.as_str()?.to_string();
    let bucket = image
        .get("bucket_uid")
        .and_then(|v| v.as_str())
        .or_else(|| output.get("output_bucket").and_then(|v| v.as_str()))
        .or(fallback_bucket)?
        .to_string();
    Some(ResizedInput { bucket_uid: bucket, filename })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_pre_step_capability() {
        assert!(is_pre_step("image_resize"));
        assert!(is_pre_step("image_resize[nearest;lanczos]"));
        assert!(!is_pre_step("imggen.flux"));
        assert!(!is_pre_step("llm.qwen3-vl:8b"));
        assert!(!is_pre_step("img-utils.depth"));
    }

    #[test]
    fn threshold_matches_the_verbatim_storage_cutoff() {
        use crate::services::image_processing::MAX_TRANSCODE_BYTES;
        // Default-on must only fire for files local processing refuses to shrink.
        assert!(EXTERNAL_RESIZE_THRESHOLD_BYTES > MAX_TRANSCODE_BYTES as i64);
    }

    #[test]
    fn payload_targets_the_stored_image_limit_without_upscaling() {
        let p = payload("resize_input_photo.jpg");
        assert_eq!(p["input_image"], "resize_input_photo.jpg");
        assert_eq!(p["mode"], "fit");
        assert_eq!(p["width"], MAX_IMAGE_EDGE);
        assert_eq!(p["allow_upscale"], false);
    }

    #[test]
    fn reads_the_resized_file_from_a_completed_poll() {
        let output = serde_json::json!({
            "output_bucket": "bucket-1",
            "image_count": 1,
            "images": [{ "filename": "resize_input_photo.jpg", "bucket_uid": "bucket-1" }],
        });
        let got = completed_output(Some(&output), None).expect("resized input");
        assert_eq!(got.bucket_uid, "bucket-1");
        assert_eq!(got.filename, "resize_input_photo.jpg");
    }

    #[test]
    fn falls_back_to_the_submitted_bucket() {
        let output = serde_json::json!({ "images": [{ "filename": "a.jpg" }] });
        let got = completed_output(Some(&output), Some("bucket-2")).expect("resized input");
        assert_eq!(got.bucket_uid, "bucket-2");
    }

    #[test]
    fn missing_output_is_not_a_resized_input() {
        assert!(completed_output(None, Some("b")).is_none());
        assert!(completed_output(Some(&serde_json::json!({})), Some("b")).is_none());
        assert!(
            completed_output(Some(&serde_json::json!({ "images": [] })), Some("b")).is_none(),
            "an empty images array has nothing to promote"
        );
    }

    #[test]
    fn staged_filename_is_sanitized_and_extensioned() {
        let name = |filename: &str, content_type: &str| {
            staged_filename(&sample_file(filename, content_type))
        };
        assert_eq!(name("my photo (1).JPEG", "image/jpeg"), "resize_input_my_photo__1_.jpg");
        assert_eq!(name("shot.png", "image/png"), "resize_input_shot.png");
        assert_eq!(name("noext", "image/jpeg"), "resize_input_noext.jpg");
    }

    fn sample_file(filename: &str, content_type: &str) -> ImageFile {
        ImageFile {
            id: 1,
            user_id: 1,
            job_id: None,
            direction: "input".into(),
            source: "upload".into(),
            storage_path: "p".into(),
            thumbnail_storage_path: None,
            thumbnail_stored_bytes: 0,
            filename: filename.into(),
            content_type: content_type.into(),
            original_bytes: None,
            stored_bytes: 1,
            original_width: None,
            original_height: None,
            stored_width: 100,
            stored_height: 100,
            exif_orientation: None,
            rescaled: false,
            reencoded: false,
            sha256: String::new(),
            offload_bucket_uid: None,
            offload_file_uid: None,
            created_at: chrono::Utc::now().fixed_offset(),
        }
    }
}
