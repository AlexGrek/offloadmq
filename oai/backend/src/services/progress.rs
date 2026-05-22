//! Lightweight running-job list for the global Progress drawer (DB only, no OffloadMQ poll).

use serde::Serialize;

use crate::{
    db::image_generation,
    error::AppError,
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
}

#[derive(Serialize)]
pub struct RunningJobsResponse {
    pub jobs: Vec<RunningJobItem>,
}

pub async fn list_running_image_jobs(
    state: &AppState,
    user_id: i64,
) -> Result<RunningJobsResponse, AppError> {
    let rows = image_generation::list_user_active_offload_tasks(&state.db, user_id).await?;
    let jobs = rows
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
        })
        .collect();
    Ok(RunningJobsResponse { jobs })
}
