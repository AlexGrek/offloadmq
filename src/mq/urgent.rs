use std::sync::Arc;

use chrono::{DateTime, TimeDelta, Utc};
use log::info;
use tokio::{sync::watch, time};

use crate::{
    error::AppError,
    models::{AssignedTask, UnassignedTask},
    schema::{TaskId, TaskStatus},
    utils::base_capability,
};

pub struct TaskState {
    pub status: tokio::sync::RwLock<TaskStatus>,
    pub notify: watch::Sender<TaskStatus>,
}

#[derive(Clone)]
pub struct UrgentTaskEntry {
    pub task: UnassignedTask,
    pub assigned_task: Option<AssignedTask>,
    pub state: Arc<TaskState>,
    pub created_at: DateTime<Utc>,
    /// Last time the task saw activity — set on assignment and on every progress
    /// update. Used to expire in-flight tasks whose agent has gone silent.
    pub last_update: DateTime<Utc>,
    /// How long to wait for an agent to pick up the task (pending phase TTL).
    pub ttl: TimeDelta,
    /// Absolute deadline computed from `timeoutSecs`. When this moment is reached
    /// the task is failed regardless of agent activity, and any in-flight
    /// assigned task is marked `CancelRequested` so the agent receives HTTP 499.
    pub global_deadline: Option<DateTime<Utc>>,
}

pub struct UrgentTaskStore {
    pub tasks: tokio::sync::RwLock<indexmap::IndexMap<TaskId, UrgentTaskEntry>>,
}

impl UrgentTaskStore {
    pub fn new() -> Arc<Self> {
        let store = Arc::new(Self {
            tasks: tokio::sync::RwLock::new(indexmap::IndexMap::new()),
        });

        // Clone Arc for the background task
        let store_clone = Arc::clone(&store);

        // Spawn background Tokio task for expiration every 10 seconds
        tokio::spawn(async move {
            let mut interval = time::interval(time::Duration::from_secs(10));
            loop {
                interval.tick().await;
                store_clone.expire_tasks().await;
            }
        });

        store
    }

    pub async fn find_with_capabilities(
        &self,
        caps: &Vec<String>,
        agent_uid: &str,
    ) -> Option<UnassignedTask> {
        self.tasks
            .read()
            .await
            .iter()
            .find(|item| {
                if item.1.assigned_task.is_some() {
                    return false;
                }
                if !caps
                    .iter()
                    .any(|c| base_capability(c) == item.1.task.id.cap.as_str())
                {
                    return false;
                }
                if let Some(runner) = item
                    .1
                    .task
                    .data
                    .payload
                    .get("runner")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                {
                    return runner == agent_uid;
                }
                true
            })
            .map(|(_id, item)| item.task.clone())
    }

    pub async fn add_task(
        &self,
        task: UnassignedTask,
        ttl_secs: i64,
        global_deadline: Option<DateTime<Utc>>,
    ) -> anyhow::Result<Arc<TaskState>> {
        let (tx, _) = watch::channel(TaskStatus::Pending);
        let state = Arc::new(TaskState {
            status: tokio::sync::RwLock::new(TaskStatus::Pending),
            notify: tx,
        });

        let entry = UrgentTaskEntry {
            task,
            assigned_task: Option::default(),
            state: state.clone(),
            created_at: Utc::now(),
            last_update: Utc::now(),
            ttl: TimeDelta::seconds(ttl_secs),
            global_deadline,
        };

        self.tasks
            .write()
            .await
            .insert(entry.task.id.clone(), entry);

        Ok(state)
    }

    pub async fn assign_task(&self, task_id: &TaskId, agent: &str) -> bool {
        let mut tasks = self.tasks.write().await;
        if let Some(entry) = tasks.get_mut(task_id) {
            let mut status = entry.state.status.write().await;
            // Only assign a still-Pending task. Mutating `assigned_task` before
            // this check let a losing racer overwrite the winner's assignment.
            if *status == TaskStatus::Pending {
                entry.assigned_task = Some(entry.task.assign_to(agent));
                entry.last_update = Utc::now();
                *status = TaskStatus::Assigned;
                let _ = entry.state.notify.send(TaskStatus::Assigned);
                return true;
            }
        }
        false
    }

    pub async fn hard_clear(&self) {
        info!("Cleaning up urgent tasks queue");

        self.tasks.write().await.clear();
    }

    pub async fn complete_task(
        &self,
        task_id: &TaskId,
        success: bool,
        payload: serde_json::Value,
    ) -> Result<bool, AppError> {
        let mut tasks = self.tasks.write().await;
        if let Some(entry) = tasks.get_mut(task_id) {
            let task = entry.assigned_task.as_mut().ok_or(AppError::Conflict(
                "Task is not assigned but reported".to_string(),
            ))?;
            let is_cancel_requested = task.status == TaskStatus::CancelRequested;
            task.result = Some(payload);
            if !is_cancel_requested {
                task.change_status(if success {
                    TaskStatus::Completed
                } else {
                    TaskStatus::Failed
                });

                let mut status = entry.state.status.write().await;
                *status = if success {
                    TaskStatus::Completed
                } else {
                    TaskStatus::Failed
                };
                let _ = entry.state.notify.send(status.clone());
            }
            if is_cancel_requested {
                return Err(AppError::ClientClosedRequest(format!(
                    "Task {} has been cancelled by the client",
                    task_id
                )));
            }
            return Ok(true);
        }
        Ok(false)
    }

    pub async fn update_task(
        &self,
        task_id: &TaskId,
        log: Option<String>,
        stage: Option<String>,
        status: Option<TaskStatus>,
    ) -> Result<bool, AppError> {
        let mut tasks = self.tasks.write().await;
        if let Some(entry) = tasks.get_mut(task_id) {
            entry.last_update = Utc::now();
            let task = entry.assigned_task.as_mut().ok_or(AppError::Conflict(
                "Task is not assigned but reported".to_string(),
            ))?;
            let is_cancel_requested = task.status == TaskStatus::CancelRequested;
            task.append_log(log);
            if let Some(stage_text) = stage {
                task.change_stage(&stage_text);
            }
            if !is_cancel_requested {
                if let Some(new_status) = status {
                    match new_status {
                        TaskStatus::Starting | TaskStatus::Running => {
                            task.change_status(new_status)
                        }
                        _ => {
                            return Err(AppError::BadRequest(format!(
                                "Status {:?} cannot be set via progress update",
                                new_status
                            )));
                        }
                    }
                }
            }
            if is_cancel_requested {
                return Err(AppError::ClientClosedRequest(format!(
                    "Task {} has been cancelled by the client",
                    task_id
                )));
            }
            return Ok(true);
        }
        Ok(false)
    }

    /// Call periodically or in a background task
    pub async fn expire_tasks(&self) {
        let now = Utc::now();
        let mut tasks = self.tasks.write().await;
        // (task_id, global_deadline_was_the_trigger)
        let mut to_remove: Vec<(TaskId, bool)> = vec![];
        for (id, entry) in tasks.iter() {
            let status = entry.state.status.read().await.clone();
            let global_expired = entry.global_deadline.map_or(false, |d| now >= d);
            let expired = match status {
                // Already terminal — the waiting submitter will remove it.
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Canceled => false,
                // Never picked up: expire when pending TTL or global deadline passes.
                TaskStatus::Pending => now - entry.created_at > entry.ttl || global_expired,
                // Picked up but in-flight: expire when the assigned agent has
                // gone silent (no progress / no resolution) for longer than the
                // TTL, OR when the global wall-clock deadline passes.
                _ => now - entry.last_update > entry.ttl || global_expired,
            };
            if expired {
                to_remove.push((id.clone(), global_expired));
            }
        }

        for (id, global_expired) in to_remove {
            // When the global deadline fires on an in-flight task, mark the
            // assigned record as CancelRequested so the agent gets HTTP 499 on
            // its next progress or resolve call.
            if global_expired {
                if let Some(entry) = tasks.get_mut(&id) {
                    if let Some(ref mut assigned) = entry.assigned_task {
                        if !matches!(
                            assigned.status,
                            TaskStatus::Completed
                                | TaskStatus::Failed
                                | TaskStatus::CancelRequested
                                | TaskStatus::Canceled
                        ) {
                            assigned.change_status(TaskStatus::CancelRequested);
                        }
                    }
                }
            }
            if let Some(entry) = tasks.get(&id) {
                let mut status = entry.state.status.write().await;
                if *status != TaskStatus::Completed && *status != TaskStatus::Failed {
                    *status = TaskStatus::Failed;
                    let _ = entry.state.notify.send(TaskStatus::Failed);
                }
            }
            tasks.shift_remove(&id);
        }
    }

    pub async fn set_runtime_estimate(&self, task_id: &TaskId, duration: std::time::Duration) {
        let mut tasks = self.tasks.write().await;
        if let Some(entry) = tasks.get_mut(task_id) {
            if let Some(assigned) = entry.assigned_task.as_mut() {
                assigned.typical_runtime_seconds = Some(duration);
            }
        }
    }

    pub async fn get_assigned_task(&self, task_id: &TaskId) -> Option<AssignedTask> {
        let assigned = self.tasks.read().await;
        assigned
            .get(task_id)
            .cloned()
            .map(|item| item.assigned_task)
            .flatten()
    }

    pub async fn remove_task(&self, task_id: &TaskId) {
        {
            let mut tasks = self.tasks.write().await;
            tasks.shift_remove(task_id);
        }
    }

    /// Cancel an urgent task (queued or in-flight). Returns `Canceled` when the
    /// task was still waiting for an agent, `CancelRequested` when an agent
    /// already holds it.
    pub async fn cancel_task(&self, task_id: &TaskId) -> Result<TaskStatus, AppError> {
        let mut tasks = self.tasks.write().await;
        let entry = tasks
            .get_mut(task_id)
            .ok_or_else(|| AppError::NotFound(task_id.to_string()))?;

        if let Some(ref mut assigned) = entry.assigned_task {
            match assigned.status {
                TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Canceled => {
                    return Err(AppError::Conflict(format!(
                        "Task {} is already in terminal state {:?}",
                        task_id, assigned.status
                    )));
                }
                TaskStatus::CancelRequested => {
                    return Err(AppError::Conflict(format!(
                        "Task {} is already cancel-requested",
                        task_id
                    )));
                }
                _ => {
                    assigned.change_status(TaskStatus::CancelRequested);
                    return Ok(TaskStatus::CancelRequested);
                }
            }
        }

        // Still pending in the urgent queue — materialize a canceled assignment
        // and wake any blocking submitter.
        let mut assigned = entry.task.clone().into_assigned("(cancelled)");
        assigned.change_status(TaskStatus::Canceled);
        entry.assigned_task = Some(assigned);
        {
            let mut status = entry.state.status.write().await;
            *status = TaskStatus::Canceled;
            let _ = entry.state.notify.send(TaskStatus::Canceled);
        }
        Ok(TaskStatus::Canceled)
    }
}
