//! Snapshot of image-generation form + OffloadMQ submit parameters per job.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::db::image_generation::ImageGenerationJob;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RescaleParams {
    pub enabled: bool,
    pub mode: String,
    pub width: i32,
    pub height: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub px: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagePipelineParams {
    pub capability: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub override_negative: bool,
    pub width: i32,
    pub height: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    pub workflow: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_image_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_preparation: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rescale: Option<RescaleParams>,
    /// Number of frames for video generation workflows (txt2video / img2video).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_length: Option<i32>,
}

impl ImagePipelineParams {
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    pub fn from_json(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(raw)
    }

    /// Reconstruct params for jobs created before `pipeline_params_json` existed.
    pub fn from_job_columns(job: &ImageGenerationJob) -> Self {
        Self {
            capability: job.capability.clone(),
            prompt: job.prompt.clone(),
            negative_prompt: job.negative_prompt.clone(),
            override_negative: job.negative_prompt.is_some(),
            width: job.width,
            height: job.height,
            seed: job.seed,
            workflow: job.workflow.clone(),
            input_image_id: job.input_image_id.map(|id| id.to_string()),
            data_preparation: None,
            video_length: None,
            rescale: if job.workflow == "img2img" {
                Some(RescaleParams {
                    enabled: true,
                    mode: "exact".to_string(),
                    width: job.width,
                    height: job.height,
                    px: None,
                    mp: None,
                })
            } else {
                None
            },
        }
    }
}

pub fn parse_stored_pipeline_params(job: &ImageGenerationJob) -> ImagePipelineParams {
    let raw = job.pipeline_params_json.trim();
    if raw.is_empty() || raw == "{}" {
        return ImagePipelineParams::from_job_columns(job);
    }
    ImagePipelineParams::from_json(raw).unwrap_or_else(|_| ImagePipelineParams::from_job_columns(job))
}
