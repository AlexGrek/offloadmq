use std::collections::HashSet;
use std::sync::Arc;

use chrono::Utc;
use log::info;
use serde::Serialize;

use crate::{
    db::apikeys::ApiKeysStorage,
    error::AppError,
    models::{AssignedTask, UnassignedTask},
    mq::{scheduler::submit_urgent_task, types::UrgentSubmitOutcome},
    schema::{TaskId, TaskStatus, TaskStatusResponse, TaskSubmissionRequest},
    state::AppState,
    utils::base_capability,
};

// ---------------------------------------------------------------------------
// Service result types (no framework dependency)
// ---------------------------------------------------------------------------

pub enum SubmitOutcome {
    Urgent(UrgentSubmitOutcome),
    Queued { id: TaskId, capability: String },
}

pub enum PollOutcome {
    Found(TaskStatusResponse),
    FoundUrgent(AssignedTask),
}

#[derive(Debug, Serialize)]
pub struct CancelOutcome {
    pub id: TaskId,
    pub status: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Helpers (moved from mod.rs)
// ---------------------------------------------------------------------------

/// Record `task_id` in every bucket listed in `file_bucket`.
/// Failures are logged as warnings rather than surfaced to the caller —
/// the task has already been accepted and bucket tracking is best-effort.
pub fn record_task_in_buckets(state: &AppState, task_id: &str, file_bucket: &[String]) {
    for bucket_uid in file_bucket {
        if let Err(e) = state.storage.buckets.add_task(bucket_uid, task_id) {
            log::warn!(
                "Failed to record task {} in bucket {}: {}",
                task_id, bucket_uid, e
            );
        }
    }
}

/// Verify that every bucket UID in `req.file_bucket` exists and is owned by
/// the submitting API key. Returns an error on the first violation.
pub fn validate_file_buckets(
    state: &AppState,
    req: &TaskSubmissionRequest,
    skip_owner: bool,
) -> Result<(), AppError> {
    for bucket_uid in &req.file_bucket {
        let bucket = state
            .storage
            .buckets
            .get_bucket(bucket_uid)?
            .ok_or_else(|| AppError::NotFound(format!("Bucket {} not found", bucket_uid)))?;
        if !skip_owner && bucket.api_key != req.api_key {
            return Err(AppError::Authorization(format!(
                "Bucket {} is not owned by the provided API key",
                bucket_uid
            )));
        }
        if bucket.rm_after_task && !bucket.tasks.is_empty() {
            return Err(AppError::Conflict(format!(
                "Bucket {} has rm_after_task set and has already been used by task {}",
                bucket_uid,
                bucket.tasks[0],
            )));
        }
    }
    if let Some(output_uid) = &req.output_bucket {
        let bucket = state
            .storage
            .buckets
            .get_bucket(output_uid)?
            .ok_or_else(|| AppError::NotFound(format!("Output bucket {} not found", output_uid)))?;
        if !skip_owner && bucket.api_key != req.api_key {
            return Err(AppError::Authorization(format!(
                "Output bucket {} is not owned by the provided API key",
                output_uid
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

pub async fn do_submit_task_blocking(
    state: &Arc<AppState>,
    req: TaskSubmissionRequest,
    skip_owner: bool,
) -> Result<UrgentSubmitOutcome, AppError> {
    if !skip_owner {
        state.storage.client_keys.verify_key(&req.api_key, &req.capability)?;
    }
    if !req.urgent {
        return Err(AppError::BadRequest(
            "Only urgent tasks can be submitted to this endpoint".to_string(),
        ));
    }
    validate_file_buckets(state, &req, skip_owner)?;
    let file_bucket = req.file_bucket.clone();
    let task = UnassignedTask {
        id: TaskId::new_with_cap(req.capability.clone()),
        data: req,
        created_at: Utc::now(),
    };
    info!("New urgent task: {:?}", task);
    record_task_in_buckets(state, &task.id.to_string(), &file_bucket);
    submit_urgent_task(&state.urgent, &state.storage.agents, task).await
}

pub async fn do_submit_task(
    state: &Arc<AppState>,
    req: TaskSubmissionRequest,
    skip_owner: bool,
) -> Result<SubmitOutcome, AppError> {
    if !skip_owner {
        state.storage.client_keys.verify_key(&req.api_key, &req.capability)?;
    }
    validate_file_buckets(state, &req, skip_owner)?;
    let urgent = req.urgent;
    let file_bucket = req.file_bucket.clone();
    let task = UnassignedTask {
        id: TaskId::new_with_cap(req.capability.clone()),
        data: req,
        created_at: Utc::now(),
    };
    info!("New unassigned task: {:?}", task);
    record_task_in_buckets(state, &task.id.to_string(), &file_bucket);
    if urgent {
        let outcome = submit_urgent_task(&state.urgent, &state.storage.agents, task).await?;
        Ok(SubmitOutcome::Urgent(outcome))
    } else {
        let id = task.id.clone();
        let capability = task.id.cap.clone();
        state.storage.tasks.add_unassigned(&task)?;
        Ok(SubmitOutcome::Queued { id, capability })
    }
}

pub async fn do_poll_task_status(
    state: &Arc<AppState>,
    task_id: TaskId,
    api_key: &str,
    skip_owner: bool,
) -> Result<PollOutcome, AppError> {
    let task = state
        .storage
        .tasks
        .get_assigned(&task_id)?
        .map(|ass| {
            if !skip_owner && ass.data.api_key != api_key {
                None
            } else {
                Some(ass.into_status_report())
            }
        })
        .flatten()
        .or(state
            .storage
            .tasks
            .get_unassigned(&task_id)?
            .map(|unass| {
                if !skip_owner && unass.data.api_key != api_key {
                    None
                } else {
                    Some(unass.into_status_report())
                }
            })
            .flatten());

    if let Some(response) = task {
        return Ok(PollOutcome::Found(response));
    }
    if let Some(urgent) = state.urgent.get_assigned_task(&task_id).await {
        return Ok(PollOutcome::FoundUrgent(urgent));
    }
    Err(AppError::NotFound(task_id.to_string()))
}

pub fn do_cancel_task(
    state: &Arc<AppState>,
    task_id: TaskId,
    api_key: &str,
    skip_owner: bool,
) -> Result<CancelOutcome, AppError> {
    // Check assigned tasks first
    if let Some(mut task) = state.storage.tasks.get_assigned(&task_id)? {
        if !skip_owner && task.data.api_key != api_key {
            return Err(AppError::NotFound(task_id.to_string()));
        }
        match task.status {
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Canceled => {
                return Err(AppError::Conflict(format!(
                    "Task {} is already in terminal state {:?}",
                    task_id, task.status
                )));
            }
            TaskStatus::CancelRequested => {
                return Err(AppError::Conflict(format!(
                    "Task {} is already cancel-requested",
                    task_id
                )));
            }
            _ => {}
        }
        task.change_status(TaskStatus::CancelRequested);
        state.storage.tasks.update_assigned(&task)?;
        info!("Task {} cancel requested (was assigned)", task_id);
        return Ok(CancelOutcome {
            id: task_id,
            status: "cancelRequested".into(),
            message: "Cancellation requested".into(),
        });
    }

    // Check unassigned tasks — remove from queue and create an assigned record
    // in Canceled state so the client can still poll it
    if let Some(unassigned) = state.storage.tasks.get_unassigned(&task_id)? {
        if !skip_owner && unassigned.data.api_key != api_key {
            return Err(AppError::NotFound(task_id.to_string()));
        }
        state.storage.tasks.remove_unassigned(&task_id)?;
        let mut assigned = unassigned.into_assigned("(cancelled)");
        assigned.change_status(TaskStatus::Canceled);
        state.storage.tasks.update_assigned(&assigned)?;
        info!("Task {} cancelled (was unassigned)", task_id);
        return Ok(CancelOutcome {
            id: task_id,
            status: "canceled".into(),
            message: "Task cancelled (was queued)".into(),
        });
    }

    Err(AppError::NotFound(task_id.to_string()))
}

pub fn do_capabilities_online(
    state: &Arc<AppState>,
    api_key: &str,
    skip_owner: bool,
    strip_extended: bool,
) -> Result<HashSet<String>, AppError> {
    let mut capabilities = HashSet::new();
    state
        .storage
        .agents
        .list_all_agents()
        .into_iter()
        .filter(|a| a.is_online())
        .flat_map(|agent| agent.capabilities)
        .for_each(|cap| {
            if strip_extended {
                capabilities.insert(base_capability(&cap).to_string());
            } else {
                capabilities.insert(cap);
            }
        });
    if !skip_owner {
        let key = state
            .storage
            .client_keys
            .find_active(api_key)?
            .ok_or_else(|| AppError::Authorization("API key not found".to_string()))?;
        capabilities.retain(|el| {
            ApiKeysStorage::has_capability(&key.capabilities, base_capability(el))
        });
    }
    Ok(capabilities)
}
