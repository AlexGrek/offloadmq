use std::sync::Arc;

use anyhow::Result;
use chrono::Utc;
use indexmap::IndexMap;
use log::info;

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

    /// Re-sync the in-memory queue from the persistent unassigned tree, adding any
    /// task that is missing in memory — tasks that were already unassigned when
    /// the process started, or any drift between the two stores. Run on every
    /// reconcile tick so such tasks are guaranteed to be in the dispatchable
    /// queue and picked up by the dispatch backstop.
    ///
    /// **Additive only:** it never removes in-memory entries, so a task submitted
    /// concurrently (added to Sled before memory) can't be dropped by a stale
    /// snapshot. A truly-assigned task is already gone from the unassigned tree,
    /// so it is never resurrected here. Returns the number of tasks newly added.
    pub async fn reconcile_unassigned_from_persistent(
        &self,
        task_storage: &TaskStorage,
    ) -> Result<usize> {
        let persistent = task_storage.list_unassigned_all()?;
        let mut guard = self.tasks.write().await;
        let mut added = 0;
        for task in persistent {
            if !guard.contains_key(&task.id) {
                guard.insert(task.id.clone(), task);
                added += 1;
            }
        }
        Ok(added)
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

    /// Pick the next assignable non-urgent task for an agent, **oldest first**.
    ///
    /// Selection is strict FIFO by `created_at` (task id as a deterministic
    /// tie-break, since ids are incremental): the longest-waiting eligible task
    /// always wins, so a queue that is drained slower than it fills can never
    /// starve its earliest entries. Insertion order of the underlying `IndexMap`
    /// is deliberately *not* used as the ordering key — tasks reloaded from Sled
    /// on startup or re-added by the reconcile sweep arrive in key order, not
    /// creation order.
    pub async fn find_with_capabilities_for_tier(
        &self,
        caps: &Vec<String>,
        tier: u8,
        agents: &AgentStorage,
        agent_uid: &str,
    ) -> Option<UnassignedTask> {
        let tasks = self.tasks.read().await;
        let mut oldest: Option<&UnassignedTask> = None;

        for task in tasks.values() {
            // Match on base capability for BOTH sides. Clients are supposed to
            // submit base caps, but a task whose cap carries extended attributes
            // (e.g. `llm.gemma4[vision;tools]`) must still match an agent that
            // advertises the same base — otherwise it sits unassigned forever.
            let task_base = base_capability(&task.id.cap);
            if !caps.iter().any(|cap| base_capability(cap) == task_base) {
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
                            .any(|cap| base_capability(cap) == task_base)
                })
                .map(|agent| agent.tier)
                .max()
                .unwrap_or_default();

            if top_online_tier > tier {
                continue;
            }

            let is_older = match oldest {
                None => true,
                Some(best) => {
                    (task.created_at, task.id.id.as_str())
                        < (best.created_at, best.id.id.as_str())
                }
            };
            if is_older {
                oldest = Some(task);
            }
        }

        oldest.cloned()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Agent, CommunicationMethod};
    use crate::schema::{SystemInfo, TaskSubmissionRequest};
    use chrono::TimeDelta;

    /// A sled-backed `AgentStorage` in a throwaway temp dir holding one online
    /// tier-0 agent for `cap` — enough for the tier filter to pass.
    fn agent_storage_with_online_agent(cap: &str) -> (AgentStorage, tempdir::TempDirGuard) {
        let guard = tempdir::TempDirGuard::new();
        let storage = AgentStorage::new(guard.path()).expect("open agent storage");
        let now = Utc::now();
        let agent = Agent {
            uid: "agent-1".into(),
            uid_short: "agent-1".into(),
            personal_login_token: String::new(),
            registered_at: now,
            last_contact: Some(now),
            last_comm_method: CommunicationMethod::Http,
            capabilities: vec![cap.to_string()],
            tier: 0,
            capacity: 1,
            system_info: SystemInfo {
                os: "test".into(),
                client: "test".into(),
                runtime: "test".into(),
                cpu_arch: "test".into(),
                cpu_model: None,
                total_memory_gb: 0,
                gpu: None,
                machine_id: None,
            },
            app_version: None,
            display_name: None,
        };
        let bytes = rmp_serde::to_vec_named(&agent).expect("serialize agent");
        storage
            .db
            .insert(agent.uid.as_bytes(), bytes)
            .expect("insert agent");
        (storage, guard)
    }

    fn task(cap: &str, id: &str, created_at: chrono::DateTime<Utc>) -> UnassignedTask {
        UnassignedTask {
            id: TaskId {
                cap: cap.to_string(),
                id: id.to_string(),
            },
            data: TaskSubmissionRequest {
                capability: cap.to_string(),
                payload: serde_json::Value::Null,
                ..Default::default()
            },
            created_at,
        }
    }

    /// Minimal scoped temp directory — sled needs a real path and the crate has
    /// no dev-dependency on `tempfile`.
    mod tempdir {
        use std::path::PathBuf;

        pub struct TempDirGuard(PathBuf);

        impl TempDirGuard {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "offloadmq-test-{}-{}",
                    std::process::id(),
                    uuid::Uuid::new_v4()
                ));
                std::fs::create_dir_all(&path).expect("create temp dir");
                Self(path)
            }

            pub fn path(&self) -> &str {
                self.0.to_str().expect("utf-8 temp path")
            }
        }

        impl Drop for TempDirGuard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[tokio::test]
    async fn picks_oldest_task_first_regardless_of_insertion_order() {
        let cap = "test.cap";
        let (agents, _guard) = agent_storage_with_online_agent(cap);
        let store = RegularTaskStore::new();

        let now = Utc::now();
        let oldest = task(cap, "t-oldest", now - TimeDelta::seconds(300));
        let middle = task(cap, "t-middle", now - TimeDelta::seconds(200));
        let newest = task(cap, "t-newest", now - TimeDelta::seconds(100));

        // Inserted newest-first: insertion order must not decide the pick.
        store.add_task(newest.clone()).await;
        store.add_task(middle.clone()).await;
        store.add_task(oldest.clone()).await;

        let caps = vec![cap.to_string()];
        let picked = store
            .find_with_capabilities_for_tier(&caps, 0, &agents, "agent-1")
            .await
            .expect("a task is eligible");
        assert_eq!(picked.id.id, "t-oldest");

        // Draining proceeds strictly in creation order.
        store.remove_task(&oldest.id).await;
        let picked = store
            .find_with_capabilities_for_tier(&caps, 0, &agents, "agent-1")
            .await
            .expect("a task is eligible");
        assert_eq!(picked.id.id, "t-middle");

        store.remove_task(&middle.id).await;
        let picked = store
            .find_with_capabilities_for_tier(&caps, 0, &agents, "agent-1")
            .await
            .expect("a task is eligible");
        assert_eq!(picked.id.id, "t-newest");
    }

    #[tokio::test]
    async fn ties_on_created_at_break_deterministically_by_task_id() {
        let cap = "test.cap";
        let (agents, _guard) = agent_storage_with_online_agent(cap);
        let store = RegularTaskStore::new();

        let created = Utc::now() - TimeDelta::seconds(60);
        store.add_task(task(cap, "t-3", created)).await;
        store.add_task(task(cap, "t-1", created)).await;
        store.add_task(task(cap, "t-2", created)).await;

        let picked = store
            .find_with_capabilities_for_tier(&vec![cap.to_string()], 0, &agents, "agent-1")
            .await
            .expect("a task is eligible");
        assert_eq!(picked.id.id, "t-1");
    }
}
