use chrono::Utc;
use log::{debug, warn};

use crate::{
    db::{
        agent::AgentStorage, heuristic_storage::HeuristicStorage,
        persistent_task_storage::TaskStorage,
    },
    error::AppError,
    models::{Agent, AssignedTask, UnassignedTask},
    mq::{
        heuristic::HeuristicRecord, regular::RegularTaskStore, types::UrgentSubmitOutcome,
        urgent::UrgentTaskStore,
    },
    schema::{TaskId, TaskResultReport, TaskResultStatus, TaskStatus, TaskUpdate},
    utils::base_capability,
};

pub async fn find_urgent_tasks_with_capabilities(
    store: &UrgentTaskStore,
    caps: &Vec<String>,
    agent_uid: &str,
) -> Option<UnassignedTask> {
    store.find_with_capabilities(caps, agent_uid).await
}

pub async fn find_assignable_non_urgent_tasks_with_capabilities_for_tier(
    store: &RegularTaskStore,
    caps: &Vec<String>,
    tier: u8,
    agents: &AgentStorage,
    agent_uid: &str,
) -> Option<UnassignedTask> {
    let found = store
        .find_with_capabilities_for_tier(caps, tier, agents, agent_uid)
        .await;
    if found.is_none() {
        debug!("No regular task eligible for tier {}", tier);
    }
    found
}

pub async fn try_pick_up_urgent_task(
    store: &UrgentTaskStore,
    agent: &Agent,
    uid: &TaskId,
) -> Result<Option<AssignedTask>, AppError> {
    let success = store.assign_task(uid, &agent.uid).await;
    if !success {
        return Ok(None);
    }
    let task_opt = store.get_assigned_task(uid).await;
    if let Some(task) = task_opt {
        Ok(Some(task))
    } else {
        Err(AppError::Conflict(uid.to_string()))
    }
}

pub async fn try_pick_up_non_urgent_task(
    regular_store: &RegularTaskStore,
    persistent_store: &TaskStorage,
    agent: &Agent,
    uid: TaskId,
) -> Result<AssignedTask, AppError> {
    let task = regular_store
        .get_task(&uid)
        .await
        .ok_or_else(|| AppError::Conflict(format!("Task already taken: {}", uid)))?;

    let removed_persistent = persistent_store.remove_unassigned(&uid)?;
    if !removed_persistent {
        return Err(AppError::Conflict(format!(
            "Task not found in persistent queue: {}",
            uid
        )));
    }

    let assigned = match regular_store.assign_task(&uid, &agent.uid).await {
        Some(assigned) => assigned,
        None => {
            if let Err(e) = persistent_store.add_unassigned(&task) {
                warn!(
                    "Failed to rollback persistent regular task {} after take race: {}",
                    uid, e
                );
            }
            return Err(AppError::Conflict(format!("Task already taken: {}", uid)));
        }
    };

    if let Err(e) = persistent_store.update_assigned(&assigned) {
        if let Err(rollback_err) = persistent_store.add_unassigned(&task) {
            warn!(
                "Failed to rollback persistent regular task {} after assign write error: {}",
                uid, rollback_err
            );
        }
        regular_store.add_task(task).await;
        return Err(e.into());
    }
    Ok(assigned)
}

pub async fn report_urgent_task<'a>(
    store: &'a UrgentTaskStore,
    report: TaskResultReport,
    task_id: TaskId,
) -> Result<bool, AppError> {
    let success = if let TaskResultStatus::Success(_duration) = report.status {
        true
    } else {
        false
    };
    store
        .complete_task(&task_id, success, report.output.clone().unwrap_or_default())
        .await
}

pub async fn update_urgent_task<'a>(
    store: &'a UrgentTaskStore,
    report: TaskUpdate,
    task_id: TaskId,
) -> Result<bool, AppError> {
    store
        .update_task(&task_id, report.log_update, report.stage, report.status)
        .await
}

pub async fn report_non_urgent_task<'a>(
    store: &TaskStorage,
    report: TaskResultReport,
    agent: &Agent,
    heuristic_storage: &HeuristicStorage,
) -> Result<(), AppError> {
    let success = matches!(&report.status, TaskResultStatus::Success(_));

    let mut got = store
        .get_assigned(&report.id)?
        .ok_or(AppError::NotFound(report.id.to_string()))?;

    let execution_time_ms = if matches!(&report.status, TaskResultStatus::NotExecuted(_)) {
        0.0
    } else {
        Utc::now()
            .signed_duration_since(got.assigned_at)
            .num_milliseconds()
            .max(0) as f64
    };

    let is_cancel_requested = got.status == TaskStatus::CancelRequested;
    if is_cancel_requested {
        // Agent acknowledged the cancel signal — move to the terminal Canceled
        // state (keeping whatever partial output the agent reported).
        got.change_status(TaskStatus::Canceled);
    } else {
        got.change_status(if success {
            TaskStatus::Completed
        } else {
            TaskStatus::Failed
        });
    }
    got.stage = None;
    got.result = report.output;
    store.update_assigned(&got)?;

    // Log heuristic for non-urgent task completion
    let buckets_used = got.data.file_bucket.clone();
    let has_files = !got.data.fetch_files.is_empty() || !buckets_used.is_empty();

    let record = HeuristicRecord::new(
        &report.id,
        agent,
        execution_time_ms,
        success,
        buckets_used,
        has_files,
    );

    if let Err(e) = heuristic_storage.log_task_completion(&record) {
        debug!("Failed to log heuristic for task {}: {}", report.id, e);
    }

    if is_cancel_requested {
        return Err(AppError::ClientClosedRequest(format!(
            "Task {} has been cancelled by the client",
            report.id
        )));
    }

    Ok(())
}

pub async fn update_non_urgent_task<'a>(
    store: &TaskStorage,
    report: TaskUpdate,
) -> Result<(), AppError> {
    let mut got = store
        .get_assigned(&report.id)?
        .ok_or(AppError::NotFound(report.id.to_string()))?;
    let is_cancel_requested = got.status == TaskStatus::CancelRequested;
    got.append_log(report.log_update);
    got.last_update_at = Some(Utc::now());
    if report.stage.is_some() {
        got.stage = report.stage
    }
    if !is_cancel_requested {
        if let Some(new_status) = report.status {
            match new_status {
                TaskStatus::Starting | TaskStatus::Running => got.change_status(new_status),
                _ => {
                    return Err(AppError::BadRequest(format!(
                        "Status {:?} cannot be set via progress update",
                        new_status
                    )));
                }
            }
        }
    }
    store.update_assigned(&got)?;
    if is_cancel_requested {
        return Err(AppError::ClientClosedRequest(format!(
            "Task {} has been cancelled by the client",
            report.id
        )));
    }
    Ok(())
}

pub async fn has_potential_agents_for(cap: &std::string::String, agents: &AgentStorage) -> bool {
    for agent in agents.list_all_agents() {
        if agent
            .capabilities
            .iter()
            .any(|c| base_capability(c) == cap.as_str())
            && agent.is_online()
        {
            return true;
        }
    }
    return false;
}

pub async fn all_online_agents_for(cap: &std::string::String, agents: &AgentStorage) -> Vec<Agent> {
    let mut collection = vec![];
    for agent in agents.list_all_agents() {
        if agent
            .capabilities
            .iter()
            .any(|c| base_capability(c) == cap.as_str())
            && agent.is_online()
        {
            collection.push(agent);
        }
    }
    collection.sort_by(|a, b| b.tier.cmp(&a.tier));
    collection
}

pub async fn submit_urgent_task(
    store: &UrgentTaskStore,
    agents: &AgentStorage,
    task: UnassignedTask,
) -> Result<UrgentSubmitOutcome, AppError> {
    if !has_potential_agents_for(&task.id.cap, agents).await {
        return Err(AppError::SchedulingImpossible(format!(
            "no online runners for capability {}",
            task.id.cap
        )));
    }
    // Pending TTL: how long to wait for an agent to pick up before giving up.
    // max_wait_secs takes precedence; fall back to 60 s for urgent tasks.
    let pending_ttl_secs = task.data.max_wait_secs.map(|s| s as i64).unwrap_or(60);
    // Global deadline: absolute moment when the overall timeout_secs fires.
    let global_deadline = task
        .data
        .timeout_secs
        .map(|ts| task.created_at + chrono::TimeDelta::seconds(ts as i64));
    let state = store
        .add_task(task.clone(), pending_ttl_secs, global_deadline)
        .await?;

    let mut rx = state.notify.subscribe();

    // Wait for status change that is terminal (Completed or Failed)
    loop {
        rx.changed().await.unwrap();
        let status = rx.borrow().clone();

        if status == TaskStatus::Completed
            || status == TaskStatus::Failed
            || status == TaskStatus::Canceled
        {
            if let Some(assigned_task) = store.get_assigned_task(&task.id).await {
                store.remove_task(&task.id).await;
                return Ok(UrgentSubmitOutcome::Completed(assigned_task));
            } else {
                store.remove_task(&task.id).await;
                return Ok(UrgentSubmitOutcome::CompletedPartial {
                    id: task.id,
                    status,
                    message: "Task completed but full info unavailable".into(),
                });
            }
        }
    }
}
