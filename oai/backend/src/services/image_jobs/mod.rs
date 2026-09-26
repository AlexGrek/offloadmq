//! Image-generation job orchestration: create/submit jobs, poll the offload
//! task, download + persist outputs, and reconcile missing results. All the
//! multi-step logic that used to live inside the image route handlers lives
//! here so the handlers stay thin (parse request → call service → map DTO).

use crate::error::ResultExt;
use std::collections::HashMap;

use base64::Engine;
use serde::Deserialize;
use serde_json::Value;

use crate::{
    db::{app_settings, generation_parameters, image_generation, imggen_capabilities, users},
    error::AppError,
    offload::{
        image_tasks::{OffloadImageClient, OffloadPollResponse, OffloadTaskId},
        task_status::{is_terminal, offload_task_missing_message, OFFLOAD_TASK_MISSING},
        LlmCapabilityInfo, OffloadClient,
    },
    services::{
        external_resize,
        image_job_names,
        image_paths,
        image_pipeline_params::{self, ImagePipelineParams, RescaleParams},
        image_processing, image_processing::ProcessedImage, offload_factory, prompt_previews,
        storage,
    },
    state::AppState,
};

mod details;
mod files;
mod outputs;
mod poll;
mod start;

pub use details::*;
pub use files::*;
pub use outputs::*;
pub use poll::*;
pub use start::*;

/// Queue-wait and execution timing derived from an offload task row. Kept as
/// two distinct durations (never summed into a "total") per product intent:
/// `queued_seconds` measures time waiting for an agent, `execution_seconds`
/// measures time actually running on one.
struct OffloadTiming {
    started_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    typical_runtime_seconds: Option<f64>,
    submitted_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    queued_seconds: Option<f64>,
    execution_seconds: Option<f64>,
}

/// OAI persists at most one generated output file per job, even when OffloadMQ
/// returns multiple images in the poll payload.
const MAX_OUTPUT_FILES_PER_JOB: usize = 1;

/// Saved-prompt bucket of the image generation Prompt textarea; completed jobs
/// attach their thumbnail to the matching entries there as a preview.
const PROMPT_BUCKET: &str = "imggen-prompt";

/// Placement metadata for a stored image — everything `store_image` needs that
/// isn't derived from the processed pixels.
struct StoredImageSpec<'a> {
    image_id: i64,
    user_id: i64,
    job_id: Option<i64>,
    direction: &'a str,
    source: &'a str,
    storage_path: &'a str,
    filename: &'a str,
    offload_bucket_uid: Option<&'a str>,
    offload_file_uid: Option<&'a str>,
}

async fn record_event(
    state: &AppState,
    job_id: i64,
    step: &str,
    event_state: &str,
    details: Option<&str>,
) -> Result<(), AppError> {
    image_generation::create_pipeline_event(&state.db, state.next_id(), job_id, step, event_state, details)
        .await?;
    Ok(())
}

async fn get_owned_input_file(
    state: &AppState,
    image_id: i64,
    user_id: i64,
) -> Result<image_generation::ImageFile, AppError> {
    image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image_generation::ImageFile;

    fn output_file(id: i64, created_ms: i64) -> ImageFile {
        ImageFile {
            id,
            user_id: 1,
            job_id: Some(10),
            direction: "output".to_string(),
            source: "offload_download".to_string(),
            storage_path: format!("out/{id}.jpg"),
            thumbnail_storage_path: None,
            thumbnail_stored_bytes: 0,
            filename: format!("out_{id}.jpg"),
            content_type: "image/jpeg".to_string(),
            original_bytes: None,
            stored_bytes: 1,
            original_width: None,
            original_height: None,
            stored_width: 1,
            stored_height: 1,
            exif_orientation: None,
            rescaled: false,
            reencoded: false,
            sha256: "abc".to_string(),
            offload_bucket_uid: None,
            offload_file_uid: None,
            created_at: chrono::DateTime::from_timestamp_millis(created_ms)
                .expect("valid test timestamp")
                .fixed_offset(),
        }
    }

    #[test]
    fn collect_output_images_prefers_live_poll_payload() {
        let live = serde_json::json!({
            "images": [
                {"file_uid": "a"},
                {"file_uid": "b"}
            ]
        });
        let cached = r#"{"images":[{"file_uid":"c"}]}"#;
        let images = collect_output_images(Some(&live), Some(cached));
        assert_eq!(images.len(), 2);
        assert_eq!(images.last().unwrap()["file_uid"], "b");
    }

    #[test]
    fn limit_job_output_files_keeps_latest_output_only() {
        let files = limit_job_output_files(vec![
            output_file(1, 100),
            output_file(2, 200),
            output_file(3, 300),
        ]);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, 3);
    }

    #[test]
    fn limit_job_output_files_preserves_non_outputs() {
        let mut input = output_file(9, 50);
        input.direction = "input".to_string();
        let files = limit_job_output_files(vec![input.clone(), output_file(1, 100), output_file(2, 200)]);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].direction, "input");
        assert_eq!(files[1].id, 2);
    }
}

