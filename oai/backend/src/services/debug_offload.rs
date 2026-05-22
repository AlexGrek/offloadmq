//! Live OffloadMQ poll snapshots for OAI debug mode (YAML).

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;

use crate::{
    db::{app_settings, image_generation},
    error::AppError,
    offload::TaskId,
    services::offload_factory,
    state::AppState,
};

#[derive(Debug, Clone)]
pub struct ExtraOffloadJob {
    pub key: String,
    pub source: String,
    pub label: Option<String>,
    pub cap: String,
    pub id: String,
}

#[derive(Serialize)]
struct OaiDbPollSnapshot {
    last_poll_status: Option<String>,
    last_poll_stage: Option<String>,
    last_poll_log: Option<String>,
    last_poll_output: Option<serde_json::Value>,
    submitted_at: String,
    updated_at: String,
}

#[derive(Serialize)]
struct DebugJobEntry {
    key: String,
    source: String,
    label: Option<String>,
    cap: String,
    id: String,
    oai_job_id: Option<String>,
    oai_job_status: Option<String>,
    oai_db_poll: Option<OaiDbPollSnapshot>,
    live_poll_error: Option<String>,
    live_poll: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct DebugSnapshot {
    fetched_at: String,
    offloadmq_url: String,
    job_count: usize,
    jobs: Vec<DebugJobEntry>,
}

pub async fn build_offload_status_yaml(
    state: &Arc<AppState>,
    user_id: i64,
    extra: Vec<ExtraOffloadJob>,
) -> Result<String, AppError> {
    let settings = app_settings::get(&state.db).await?;
    let client = offload_factory::chat_client(state).await?;

    let mut entries: HashMap<String, DebugJobEntry> = HashMap::new();

    for (job, task) in image_generation::list_user_active_offload_tasks(&state.db, user_id).await? {
        let key = format!("image:{}", job.id);
        let oai_db_poll = Some(OaiDbPollSnapshot {
            last_poll_status: task.last_poll_status.clone(),
            last_poll_stage: task.last_poll_stage.clone(),
            last_poll_log: task.last_poll_log.clone(),
            last_poll_output: task
                .last_poll_output
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok()),
            submitted_at: task.submitted_at.to_rfc3339(),
            updated_at: task.updated_at.to_rfc3339(),
        });
        entries.insert(
            key.clone(),
            DebugJobEntry {
                key,
                source: "image".to_string(),
                label: Some(format!("image job {}", job.id)),
                cap: task.offload_cap.clone(),
                id: task.offload_task_id.clone(),
                oai_job_id: Some(job.id.to_string()),
                oai_job_status: Some(job.status.clone()),
                oai_db_poll,
                live_poll_error: None,
                live_poll: None,
            },
        );
    }

    for job in extra {
        if entries.contains_key(&job.key) {
            continue;
        }
        entries.insert(
            job.key.clone(),
            DebugJobEntry {
                key: job.key,
                source: job.source,
                label: job.label,
                cap: job.cap,
                id: job.id,
                oai_job_id: None,
                oai_job_status: None,
                oai_db_poll: None,
                live_poll_error: None,
                live_poll: None,
            },
        );
    }

    let mut jobs: Vec<DebugJobEntry> = entries.into_values().collect();
    jobs.sort_by(|a, b| a.key.cmp(&b.key));

    for entry in &mut jobs {
        let task_id = TaskId {
            cap: entry.cap.clone(),
            id: entry.id.clone(),
        };
        match client.poll_task_raw(&task_id).await {
            Ok(val) => entry.live_poll = Some(val),
            Err(e) => entry.live_poll_error = Some(e.to_string()),
        }
    }

    let snapshot = DebugSnapshot {
        fetched_at: chrono::Utc::now().to_rfc3339(),
        offloadmq_url: settings.offloadmq_url,
        job_count: jobs.len(),
        jobs,
    };

    serde_yaml::to_string(&snapshot)
        .map_err(|e| AppError::Internal(format!("yaml encode failed: {e}")))
}
