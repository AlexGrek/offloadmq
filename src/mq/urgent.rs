use std::sync::Arc;

use chrono::{DateTime, TimeDelta, Utc};
use tokio::{sync::watch, time};
use uuid::Uuid;

use crate::{
    error::AppError, models::{AssignedTask, UnassignedTask}, schema::TaskStatus
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
    pub ttl: TimeDelta,
}

pub struct UrgentTaskStore {
    pub tasks: tokio::sync::RwLock<indexmap::IndexMap<Uuid, UrgentTaskEntry>>,
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

    pub async fn find_with_capabilities(&self, caps: &Vec<String>) -> Option<UnassignedTask> {
        self.tasks
            .read()
            .await
            .iter()
            .find(|item| item.1.assigned_task.is_none() && caps.contains(&item.1.task.capability))
            .map(|(_id, item)| item.task.clone())
    }

    pub async fn add_task(
        &self,
        task: UnassignedTask,
        ttl_secs: i64,
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
            ttl: TimeDelta::seconds(ttl_secs),
        };

        self.tasks.write().await.insert(entry.task.id, entry);

        Ok(state)
    }

    pub async fn assign_task(&self, task_id: &Uuid, agent: &str) -> bool {
        let mut tasks = self.tasks.write().await;
        if let Some(entry) = tasks.get_mut(task_id) {
            entry.assigned_task = Some(entry.task.assign_to(agent));
            let mut status = entry.state.status.write().await;
            if *status == TaskStatus::Pending {
                *status = TaskStatus::Assigned;
                let _ = entry.state.notify.send(TaskStatus::Assigned);
                return true;
            }
        }
        false
    }

    pub async fn complete_task(&self, task_id: &Uuid, success: bool, payload: serde_json::Value) -> Result<(), AppError> {
        let mut tasks = self.tasks.write().await;
        if let Some(entry) = tasks.get_mut(task_id) {
            entry.assigned_task.as_mut().ok_or(AppError::Conflict("Task is not assigned but reported".to_string()))?.result = Some(payload);
            let mut status = entry.state.status.write().await;
            *status = if success {
                TaskStatus::Completed
            } else {
                TaskStatus::Failed
            };
            let _ = entry.state.notify.send(status.clone());
        }
        Ok(())
    }

    /// Call periodically or in a background task
    pub async fn expire_tasks(&self) {
        let now = Utc::now();
        let mut tasks = self.tasks.write().await;
        let mut to_remove = vec![];
        for (id, entry) in tasks.iter() {
            if *entry.state.status.read().await == TaskStatus::Pending
                && now - entry.created_at > entry.ttl
            {
                to_remove.push(id.clone());
            }
        }

        for id in to_remove {
            if let Some(entry) = tasks.get(&id) {
                let mut status = entry.state.status.write().await;
                *status = TaskStatus::Failed;
                let _ = entry.state.notify.send(TaskStatus::Failed);
            }
            tasks.shift_remove(&id);
        }
    }

    pub async fn get_assigned_task(&self, task_id: &Uuid) -> Option<AssignedTask> {
        let assigned = self.tasks.read().await;
        assigned
            .get(task_id)
            .cloned()
            .map(|item| item.assigned_task)
            .flatten()
    }

    pub async fn remove_task(&self, task_id: &Uuid) {
        {
            let mut tasks = self.tasks.write().await;
            tasks.shift_remove(task_id);
        }
    }
}
