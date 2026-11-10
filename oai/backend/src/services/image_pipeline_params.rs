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

/// A persisted post-generation upscale, replayed on retry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpscaleParams {
    pub capability: String,
    pub workflow: String,
    pub scale: f64,
}

impl UpscaleParams {
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        if !self.scale.is_finite() || !(1.0..=8.0).contains(&self.scale)
            || !self.capability.starts_with("img-utils.")
            || !self.workflow.starts_with("upscale")
        {
            return Err(crate::error::AppError::BadRequest(
                "upscale requires an img-utils upscaler and a scale between 1 and 8".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImagePipelineParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upscale: Option<UpscaleParams>,
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
    /// Whether the input image was shrunk by an `image_resize` pre-step on an
    /// agent instead of locally. Recorded so "Edit prompt" and retry replay it,
    /// and so the promote step can rebuild this job's real task. Jobs created
    /// before the option existed deserialize as `false`.
    #[serde(default)]
    pub external_resize: bool,
    /// Submit this job's OffloadMQ tasks at high priority (2) instead of
    /// regular, so they jump the non-urgent queue. Replayed on retry / "Edit
    /// prompt"; jobs created before the option deserialize as `false`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub high_priority: bool,
    #[serde(default)]
    pub priority: crate::offload::image_tasks::ImageTaskPriority,
    /// Raw prompt before placeholder expansion (see `StartJobParams::prompt_template`);
    /// replayed on retry so the retried result also refreshes the saved-prompt preview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_template: Option<String>,
}

impl ImagePipelineParams {
    pub fn queue_priority(&self) -> crate::offload::image_tasks::ImageTaskPriority {
        self.priority.with_legacy_high(self.high_priority)
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    pub fn from_json(raw: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(raw)
    }

    /// Reconstruct params for jobs created before `pipeline_params_json` existed.
    pub fn from_job_columns(job: &ImageGenerationJob) -> Self {
        Self {
            upscale: None,
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
            // Predates the option, so it can never have been used.
            external_resize: false,
            high_priority: false,
            priority: Default::default(),
            prompt_template: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_upscale_configuration() {
        let mut p = UpscaleParams {
            capability: "img-utils.seedvr2".into(), workflow: "upscale".into(), scale: 2.0,
        };
        for scale in [f64::NAN, f64::INFINITY, 0.0, 0.99, 8.01] {
            p.scale = scale;
            assert!(p.validate().is_err());
        }
        for scale in [1.0, 2.5, 8.0] {
            p.scale = scale;
            assert!(p.validate().is_ok());
        }
        p.workflow = "depth".into();
        assert!(p.validate().is_err());
        p.workflow = "upscale".into();
        p.capability = "imggen.test".into();
        assert!(p.validate().is_err());
    }
}
