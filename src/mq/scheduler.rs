use std::sync::Arc;

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
    state::AppState,
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

/// Revert a non-urgent task that was assigned back to the queue (push-failure
/// recovery / disconnect re-queue). Mirrors the rollback inside
/// `try_pick_up_non_urgent_task`: the persistent store atomically moves the
/// record from assigned → unassigned (only when still un-started), then it is
/// re-added to the in-memory queue. Returns true if the task was re-queued.
pub async fn try_unassign_non_urgent_task(
    regular_store: &RegularTaskStore,
    persistent_store: &TaskStorage,
    task_id: &TaskId,
) -> Result<bool, AppError> {
    match persistent_store.unassign_task(task_id)? {
        Some(unassigned) => {
            regular_store.add_task(unassigned).await;
            Ok(true)
        }
        None => Ok(false),
    }
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
    let output = output_with_failure_message(&report).unwrap_or_default();
    store.complete_task(&task_id, success, output).await
}

/// The task output to store for a result report. A failure or not-executed
/// report with no output of its own keeps its message as `{"error": msg}` —
/// otherwise the reason only lived in the report status and was dropped.
fn output_with_failure_message(report: &TaskResultReport) -> Option<serde_json::Value> {
    let is_empty = match &report.output {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::Object(m)) => m.is_empty(),
        _ => false,
    };
    let message = match &report.status {
        TaskResultStatus::Failure(msg, _) | TaskResultStatus::NotExecuted(msg) => msg,
        TaskResultStatus::Success(_) => return report.output.clone(),
    };
    if is_empty && !message.is_empty() {
        Some(serde_json::json!({ "error": message }))
    } else {
        report.output.clone()
    }
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
    got.result = output_with_failure_message(&report);
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
        &got.data.payload,
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
    let base = base_capability(cap);
    for agent in agents.list_all_agents() {
        if agent
            .capabilities
            .iter()
            .any(|c| base_capability(c) == base)
            && agent.is_online()
        {
            return true;
        }
    }
    return false;
}

pub async fn all_online_agents_for(cap: &std::string::String, agents: &AgentStorage) -> Vec<Agent> {
    let base = base_capability(cap);
    let mut collection = vec![];
    for agent in agents.list_all_agents() {
        if agent
            .capabilities
            .iter()
            .any(|c| base_capability(c) == base)
            && agent.is_online()
        {
            collection.push(agent);
        }
    }
    collection.sort_by(|a, b| b.tier.cmp(&a.tier));
    collection
}

pub async fn submit_urgent_task(
    app_state: &Arc<AppState>,
    task: UnassignedTask,
) -> Result<UrgentSubmitOutcome, AppError> {
    Ok(enqueue_urgent_task(app_state, task)
        .await?
        .wait_terminal()
        .await)
}

/// Put an urgent task in the in-memory store and push it to a connected agent,
/// without waiting for the result. The returned [`UrgentHandle`] observes the
/// task's status; [`UrgentHandle::wait_terminal`] gives the blocking behaviour
/// of [`submit_urgent_task`].
pub async fn enqueue_urgent_task(
    app_state: &Arc<AppState>,
    task: UnassignedTask,
) -> Result<UrgentHandle, AppError> {
    let store = &app_state.urgent;
    let agents = &app_state.storage.agents;
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
    let task_state = store
        .add_task(task.clone(), pending_ttl_secs, global_deadline)
        .await?;

    // Subscribe BEFORE dispatching so an instant take+resolve can't be missed.
    let rx = task_state.notify.subscribe();

    // Push the task to a connected eligible agent now instead of waiting for a
    // poll. The pushed agent takes + resolves, which notifies `rx`.
    crate::mq::dispatch::dispatch_for_capability(app_state, &task.id.cap).await;

    Ok(UrgentHandle {
        state: app_state.clone(),
        task_id: task.id,
        _task_state: task_state,
        rx,
        finished: false,
        cancel_on_drop: false,
    })
}

/// A submitted urgent task that has not been collected yet.
///
/// Whoever holds it is responsible for removing the task from the urgent store
/// once it is terminal ([`Self::finish`]) — `expire_tasks` leaves terminal
/// entries for the submitter. If the handle is dropped before that (the HTTP
/// client went away), `Drop` removes a finished task, and with
/// [`Self::cancel_on_drop`] also cancels one that is still queued or running.
pub struct UrgentHandle {
    state: Arc<AppState>,
    task_id: TaskId,
    /// Keeps the watch sender alive even after `expire_tasks` drops the entry.
    _task_state: Arc<crate::mq::urgent::TaskState>,
    rx: tokio::sync::watch::Receiver<TaskStatus>,
    finished: bool,
    cancel_on_drop: bool,
}

impl UrgentHandle {
    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    /// Cancel the task if the handle is dropped before it finished.
    pub fn cancel_on_drop(mut self) -> Self {
        self.cancel_on_drop = true;
        self
    }

    /// Wait for the next status change and return the new status.
    pub async fn changed(&mut self) -> TaskStatus {
        // The sender lives in `_task_state`, so this can't fail.
        let _ = self.rx.changed().await;
        self.rx.borrow_and_update().clone()
    }

    /// Wait until the task is terminal, then collect it.
    pub async fn wait_terminal(mut self) -> UrgentSubmitOutcome {
        loop {
            let status = self.changed().await;
            if status.is_terminal() {
                return self.finish(status).await;
            }
        }
    }

    /// Collect a terminal task and remove it from the urgent store.
    pub async fn finish(mut self, status: TaskStatus) -> UrgentSubmitOutcome {
        let store = &self.state.urgent;
        let assigned = store.get_assigned_task(&self.task_id).await;
        store.remove_task(&self.task_id).await;
        self.finished = true;
        match assigned {
            Some(assigned_task) => UrgentSubmitOutcome::Completed(assigned_task),
            None => UrgentSubmitOutcome::CompletedPartial {
                id: self.task_id.clone(),
                status,
                message: "Task completed but full info unavailable".into(),
            },
        }
    }
}

impl Drop for UrgentHandle {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let state = self.state.clone();
        let task_id = self.task_id.clone();
        let terminal = self.rx.borrow().is_terminal();
        let cancel = self.cancel_on_drop && !terminal;
        rt.spawn(async move {
            if cancel {
                debug!(
                    "Urgent task {} abandoned by its client, cancelling",
                    task_id
                );
                match crate::api::client::service::do_cancel_task(&state, task_id.clone(), "", true)
                    .await
                {
                    // Still queued: nobody will resolve it, drop it now. An
                    // in-flight task stays until the agent stops and the entry
                    // goes silent, then `expire_tasks` removes it.
                    Ok(outcome) if outcome.status == "canceled" => {
                        state.urgent.remove_task(&task_id).await
                    }
                    Ok(_) => {}
                    Err(e) => debug!("Cancel of abandoned task {} failed: {}", task_id, e),
                }
            } else if terminal {
                state.urgent.remove_task(&task_id).await;
            }
        });
    }
}
