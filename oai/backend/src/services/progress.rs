//! Lightweight running-job list for the global Progress drawer (DB only, no OffloadMQ poll).
//! Covers image generation (`source: "image"`) and describe (`source: "describe"`).

use serde::Serialize;

use crate::{
    db::{image_analysis, image_generation},
    error::AppError,
    offload::base_capability,
    services::image_job_names,
    state::AppState,
};

#[derive(Serialize)]
pub struct RunningJobItem {
    pub key: String,
    pub source: String,
    pub label: String,
    pub status: String,
    pub stage: Option<String>,
    pub job_id: String,
    pub offload_cap: String,
    pub offload_task_id: String,
    pub started_at: Option<String>,
    pub typical_runtime_seconds: Option<f64>,
    pub submitted_at: Option<String>,
}

#[derive(Serialize)]
pub struct RunningJobsResponse {
    pub jobs: Vec<RunningJobItem>,
}

pub async fn list_running_jobs(
    state: &AppState,
    user_id: i64,
) -> Result<RunningJobsResponse, AppError> {
    let rows = image_generation::list_user_active_offload_tasks(&state.db, user_id).await?;
    let mut jobs: Vec<RunningJobItem> = rows
        .into_iter()
        .map(|(job, task)| RunningJobItem {
            key: format!("image:{}", job.id),
            source: "image".to_string(),
            label: image_job_names::prompt_label(&job, 48),
            status: task
                .last_poll_status
                .clone()
                .unwrap_or_else(|| job.status.clone()),
            stage: task.last_poll_stage.clone(),
            job_id: job.id.to_string(),
            offload_cap: task.offload_cap,
            offload_task_id: task.offload_task_id,
            started_at: task.started_at.map(|d| d.to_rfc3339()),
            typical_runtime_seconds: task.typical_runtime_seconds.filter(|s| *s > 0.0),
            submitted_at: Some(task.submitted_at.to_rfc3339()),
        })
        .collect();

    let describe = image_analysis::list_user_active(&state.db, user_id).await?;
    jobs.extend(describe.into_iter().map(|job| RunningJobItem {
        key: format!("describe:{}", job.id),
        source: "describe".to_string(),
        label: format!("Describe · {}", base_capability(&job.capability)),
        status: job.status,
        stage: job.stage,
        job_id: job.id.to_string(),
        offload_cap: job.offload_cap.unwrap_or_default(),
        offload_task_id: job.offload_task_id.unwrap_or_default(),
        started_at: None,
        typical_runtime_seconds: None,
        submitted_at: Some(job.created_at.to_rfc3339()),
    }));

    Ok(RunningJobsResponse { jobs })
}
