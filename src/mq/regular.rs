use std::sync::Arc;

use anyhow::Result;
use chrono::Utc;
use indexmap::IndexMap;
use log::info;
use rand::seq::IndexedRandom;

use crate::{
    db::{agent::AgentStorage, persistent_task_storage::TaskStorage},
    models::{AssignedTask, UnassignedTask},
    schema::{TaskId, TaskStatus},
    utils::base_capability,
};

#[derive(Clone)]
pub struct RegularTaskStore {
    tasks: Arc<tokio::sync::RwLock<IndexMap<TaskId, UnassignedTask>>>,
}

impl RegularTaskStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            tasks: Arc::new(tokio::sync::RwLock::new(IndexMap::new())),
        })
    }

    pub async fn add_task(&self, task: UnassignedTask) {
        self.tasks.write().await.insert(task.id.clone(), task);
    }

    pub async fn load_from_persistent(&self, task_storage: &TaskStorage) -> Result<usize> {
        let tasks = task_storage.list_unassigned_all()?;
        let count = tasks.len();
        let mut guard = self.tasks.write().await;
        for task in tasks {
            guard.insert(task.id.clone(), task);
        }
        Ok(count)
    }

    pub async fn get_task(&self, task_id: &TaskId) -> Option<UnassignedTask> {
        self.tasks.read().await.get(task_id).cloned()
    }

    pub async fn list_all(&self) -> Vec<UnassignedTask> {
        self.tasks.read().await.values().cloned().collect()
    }

    pub async fn hard_clear(&self) {
        info!("Cleaning up regular tasks queue");
        self.tasks.write().await.clear();
    }

    pub async fn remove_task(&self, task_id: &TaskId) -> Option<UnassignedTask> {
        self.tasks.write().await.shift_remove(task_id)
    }

    pub async fn assign_task(&self, task_id: &TaskId, agent_id: &str) -> Option<AssignedTask> {
        self.tasks
            .write()
            .await
            .shift_remove(task_id)
            .map(|task| task.assign_to(agent_id))
    }

    pub async fn find_with_capabilities_for_tier(
        &self,
        caps: &Vec<String>,
        tier: u8,
        agents: &AgentStorage,
        agent_uid: &str,
    ) -> Option<UnassignedTask> {
        let tasks = self.tasks.read().await;
        let mut eligible: Vec<UnassignedTask> = Vec::new();

        for task in tasks.values() {
            if !caps
                .iter()
                .any(|cap| base_capability(cap) == task.id.cap.as_str())
            {
                continue;
            }
            if let Some(runner) = task
                .data
                .payload
                .get("runner")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                if runner != agent_uid {
                    continue;
                }
            }

            let top_online_tier = agents
                .list_all_agents()
                .into_iter()
                .filter(|agent| {
                    agent.is_online()
                        && agent
                            .capabilities
                            .iter()
                            .any(|cap| base_capability(cap) == task.id.cap.as_str())
                })
                .map(|agent| agent.tier)
                .max()
                .unwrap_or_default();

            if top_online_tier <= tier {
                eligible.push(task.clone());
            }
        }

        if eligible.is_empty() {
            None
        } else {
            let mut rng = rand::rng();
            eligible.choose(&mut rng).cloned()
        }
    }

    /// Fail queued non-urgent tasks that exceeded max wait or total timeout.
    pub async fn expire_timed_out_unassigned(&self, task_storage: &TaskStorage) -> Result<usize> {
        let now = Utc::now();
        let snapshot: Vec<(TaskId, UnassignedTask)> = self
            .tasks
            .read()
            .await
            .iter()
            .map(|(id, task)| (id.clone(), task.clone()))
            .collect();

        let mut to_expire: Vec<TaskId> = Vec::new();
        for (task_id, task) in snapshot {
            let elapsed = (now - task.created_at).num_seconds().max(0) as u64;
            let wait_expired = task.data.max_wait_secs.map_or(false, |mw| elapsed >= mw);
            let total_expired = task.data.timeout_secs.map_or(false, |ts| elapsed >= ts);
            if wait_expired || total_expired {
                to_expire.push(task_id);
            }
        }

        let mut count = 0;
        for task_id in to_expire {
            let Some(task_snapshot) = self.get_task(&task_id).await else {
                continue;
            };
            let removed_persistent = task_storage.remove_unassigned(&task_snapshot.id)?;
            if !removed_persistent {
                continue;
            }
            let Some(task) = self.remove_task(&task_id).await else {
                // In-memory race after persistent remove. Restore persistence.
                let _ = task_storage.add_unassigned(&task_snapshot)?;
                continue;
            };
            let mut assigned = task.into_assigned("(timeout)");
            assigned.change_status(TaskStatus::Failed);
            assigned.stage = None;
            if let Err(e) = task_storage.update_assigned(&assigned) {
                // Best-effort rollback to avoid orphaning the queue entry.
                let _ = task_storage.add_unassigned(&task_snapshot)?;
                self.add_task(task_snapshot).await;
                return Err(e);
            }
            count += 1;
            info!(
                "Task {} timed out while queued in regular store, marked failed",
                assigned.id
            );
        }
        Ok(count)
    }
}
