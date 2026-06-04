use anyhow::Result;
use chrono::Utc;
use log::info;
use sled::Db;
use sled::Transactional;
use sled::transaction::{TransactionError, abort};

use crate::{
    error::AppError,
    models::{AssignedTask, UnassignedTask},
    schema::{TaskId, TaskStatus},
    utils::base_capability,
};

pub struct TaskStorage {
    _db: Db,
    unassigned: sled::Tree,
    assigned: sled::Tree,
    archived: sled::Tree,
}

impl TaskStorage {
    /// Open or create a new task storage in the given path
    pub fn open(path: &str) -> Result<Self> {
        let db = sled::open(path)?;
        let unassigned = db.open_tree("tasks_unassigned")?;
        let assigned = db.open_tree("tasks_assigned")?;
        let archived = db.open_tree("tasks_archived")?;

        Ok(Self {
            _db: db,
            unassigned,
            assigned,
            archived,
        })
    }

    /// Create composite key: "capability|uuid"
    fn make_key(id: &TaskId) -> String {
        format!("{}|{}", id.cap, id.id)
    }

    /// Add a new unassigned task
    pub fn add_unassigned(&self, task: &UnassignedTask) -> Result<()> {
        let key = Self::make_key(&task.id);
        let bytes = rmp_serde::to_vec_named(task)?;
        self.unassigned.insert(key.as_bytes(), bytes)?;
        Ok(())
    }

    /// Move a task from unassigned to assigned when agent confirms.
    ///
    /// The remove-from-unassigned + insert-into-assigned pair runs in a single
    /// Sled transaction so the task is never momentarily absent from both trees
    /// and a crash cannot drop it. Serialization happens outside the closure;
    /// the transactional `remove` is the arbiter against concurrent claims.
    pub fn assign_task(&self, id: &TaskId, agent_id: &str) -> Result<AssignedTask, AppError> {
        let key = Self::make_key(id);
        let value = self
            .unassigned
            .get(key.as_bytes())?
            .ok_or_else(|| AppError::Conflict(format!("Unassigned task not found: {}", id)))?;
        let unassigned: UnassignedTask = rmp_serde::from_slice(&value)?;
        let assigned = unassigned.assign_to(agent_id);
        let bytes = rmp_serde::to_vec_named(&assigned)?;

        let res = (&self.unassigned, &self.assigned).transaction(move |(un, asg)| {
            // If the task is gone, a racer (another agent or the timeout sweep)
            // already claimed it — abort so we don't resurrect a stale copy.
            if un.remove(key.as_bytes())?.is_none() {
                return abort(());
            }
            asg.insert(key.as_bytes(), bytes.clone())?;
            Ok(())
        });

        match res {
            Ok(()) => Ok(assigned),
            Err(TransactionError::Abort(())) => {
                Err(AppError::Conflict(format!("Task already taken: {}", id)))
            }
            Err(TransactionError::Storage(e)) => Err(AppError::Database(e)),
        }
    }

    /// Archive terminal tasks whose retention window (7 days from completion)
    /// has elapsed. Only terminal tasks are archived; non-terminal tasks are
    /// driven to a terminal state by the timeout, cancel-escalation, and
    /// orphan-recovery sweeps before they ever become eligible here. The
    /// retention clock starts at `finished_at` (falling back to `assigned_at`
    /// for records written before that field existed).
    pub fn archive_stale_tasks(&self) -> Result<()> {
        let now = Utc::now();
        let cutoff = now - chrono::Duration::days(7);

        let mut to_archive = Vec::new();

        for item in self.assigned.iter() {
            let (k, v) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&v)?;
            let retain_from = task.finished_at.unwrap_or(task.assigned_at);
            if task.status.is_terminal() && retain_from < cutoff {
                to_archive.push((k, v));
            }
        }

        for (k, v) in to_archive {
            self.assigned.remove(&k)?;
            self.archived.insert(&k, v)?;
        }

        Ok(())
    }

    /// Revert an assigned task back to the unassigned queue.
    ///
    /// Used by the push dispatcher when a push send fails before the agent
    /// received the task, and on WS disconnect to re-queue tasks the agent never
    /// started. Only reverts tasks still in `Assigned` status — a `Starting` /
    /// `Running` task is being worked on (left to the agent / orphan recovery),
    /// and terminal tasks are done. The remove-from-assigned + insert-into-
    /// unassigned pair runs in one transaction. Returns the restored task, or
    /// `None` if it was missing or no longer un-started.
    pub fn unassign_task(&self, id: &TaskId) -> Result<Option<UnassignedTask>, AppError> {
        let key = Self::make_key(id);
        let value = match self.assigned.get(key.as_bytes())? {
            Some(v) => v,
            None => return Ok(None),
        };
        let assigned: AssignedTask = rmp_serde::from_slice(&value)?;
        if assigned.status != TaskStatus::Assigned {
            return Ok(None);
        }
        let unassigned = UnassignedTask {
            id: assigned.id.clone(),
            data: assigned.data.clone(),
            created_at: assigned.created_at,
        };
        let bytes = rmp_serde::to_vec_named(&unassigned)?;
        let res = (&self.assigned, &self.unassigned).transaction(move |(asg, un)| {
            // If the assigned record is gone, a concurrent resolve / sweep handled
            // it — abort so we don't resurrect a stale copy.
            if asg.remove(key.as_bytes())?.is_none() {
                return abort(());
            }
            un.insert(key.as_bytes(), bytes.clone())?;
            Ok(())
        });
        match res {
            Ok(()) => Ok(Some(unassigned)),
            Err(TransactionError::Abort(())) => Ok(None),
            Err(TransactionError::Storage(e)) => Err(AppError::Database(e)),
        }
    }

    /// Remove an unassigned task by id (returns true if it existed)
    pub fn remove_unassigned(&self, id: &TaskId) -> Result<bool> {
        let key = Self::make_key(id);
        Ok(self.unassigned.remove(key.as_bytes())?.is_some())
    }

    /// Get an unassigned task by id
    pub fn get_unassigned(&self, id: &TaskId) -> Result<Option<UnassignedTask>> {
        let key = Self::make_key(id);
        if let Some(value) = self.unassigned.get(key.as_bytes())? {
            Ok(Some(rmp_serde::from_slice(&value)?))
        } else {
            Ok(None)
        }
    }

    /// Get an assigned task by id
    pub fn get_assigned(&self, id: &TaskId) -> Result<Option<AssignedTask>> {
        let key = Self::make_key(id);
        if let Some(value) = self.assigned.get(key.as_bytes())? {
            Ok(Some(rmp_serde::from_slice(&value)?))
        } else {
            Ok(None)
        }
    }

    pub fn update_assigned(&self, assigned: &AssignedTask) -> Result<()> {
        let bytes = rmp_serde::to_vec_named(assigned)?;
        let key = Self::make_key(&assigned.id);
        self.assigned.insert(key.as_bytes(), bytes)?;
        return Ok(());
    }

    pub fn hard_clear(&self) -> Result<()> {
        info!("Performing tasks database cleanup");
        self.assigned.clear()?;
        self.unassigned.clear()?;
        self.archived.clear()?;
        Ok(())
    }

    /// List unassigned tasks for a given capability
    pub fn list_unassigned_for_capability(&self, capability: &str) -> Result<Vec<UnassignedTask>> {
        let prefix = format!("{}|", capability);
        let mut result = Vec::new();

        for item in self.unassigned.scan_prefix(prefix.as_bytes()) {
            let (_k, v) = item?;
            let task: UnassignedTask = rmp_serde::from_slice(&v)?;
            result.push(task);
        }

        Ok(result)
    }

    pub fn list_unassigned_with_caps(&self, caps: &Vec<String>) -> Result<Vec<UnassignedTask>> {
        Ok(caps
            .iter()
            .filter_map(|x| self.list_unassigned_for_capability(base_capability(x)).ok())
            .flatten()
            .collect())
    }

    pub fn list_unassigned_all(&self) -> Result<Vec<UnassignedTask>> {
        let mut result = Vec::new();
        // The iter() method returns an iterator over all key-value pairs in the tree.
        for item in self.unassigned.iter() {
            // Each item is a sled::Result<(IVec, IVec)>
            let (_key, value) = item?;
            let task: UnassignedTask = rmp_serde::from_slice(&value)?;
            result.push(task);
        }
        Ok(result)
    }

    /// Fail unassigned tasks that have exceeded their `maxWaitSecs` or total
    /// `timeoutSecs` deadline (measured from creation). Moves them to the
    /// assigned tree in `Failed` state so clients can still poll for results.
    /// Returns the number of tasks that were expired.
    pub fn expire_timed_out_unassigned(&self) -> Result<usize> {
        let now = Utc::now();
        let mut to_expire: Vec<UnassignedTask> = Vec::new();

        for item in self.unassigned.iter() {
            let (_k, v) = item?;
            let task: UnassignedTask = rmp_serde::from_slice(&v)?;

            let elapsed = (now - task.created_at).num_seconds().max(0) as u64;
            let wait_expired = task.data.max_wait_secs.map_or(false, |mw| elapsed >= mw);
            let total_expired = task.data.timeout_secs.map_or(false, |ts| elapsed >= ts);

            if wait_expired || total_expired {
                to_expire.push(task);
            }
        }

        let mut count = 0;
        for task in to_expire {
            let key = Self::make_key(&task.id);
            // The atomic remove is the arbiter: if it returns None, an agent
            // (or another sweep) claimed the task between the scan and now.
            // Skip it so we never overwrite a legitimate assigned record.
            if self.unassigned.remove(key.as_bytes())?.is_none() {
                continue;
            }
            let mut assigned = task.into_assigned("(timeout)");
            assigned.change_status(TaskStatus::Failed);
            assigned.stage = None;
            self.update_assigned(&assigned)?;
            count += 1;
            info!(
                "Task {} timed out while unassigned, marked failed",
                assigned.id
            );
        }

        Ok(count)
    }

    /// Set `CancelRequested` on assigned tasks that have exceeded their total
    /// `timeoutSecs` from creation. The agent receives HTTP 499 on its next
    /// progress or resolve call and should stop work gracefully.
    /// Returns the number of tasks that were signalled.
    pub fn cancel_timed_out_assigned(&self) -> Result<usize> {
        let now = Utc::now();
        let mut to_cancel: Vec<AssignedTask> = Vec::new();

        for item in self.assigned.iter() {
            let (_k, v) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&v)?;

            let timeout_secs = match task.data.timeout_secs {
                Some(ts) => ts,
                None => continue,
            };

            let elapsed = (now - task.created_at).num_seconds().max(0) as u64;
            if elapsed < timeout_secs {
                continue;
            }

            if matches!(
                task.status,
                TaskStatus::Completed
                    | TaskStatus::Failed
                    | TaskStatus::Canceled
                    | TaskStatus::CancelRequested
            ) {
                continue;
            }

            to_cancel.push(task);
        }

        let count = to_cancel.len();
        for mut task in to_cancel {
            task.change_status(TaskStatus::CancelRequested);
            self.update_assigned(&task)?;
            info!(
                "Task {} exceeded {}s total timeout, sending cancel signal to agent",
                task.id,
                task.data.timeout_secs.unwrap_or(0)
            );
        }

        Ok(count)
    }

    /// Force-fail tasks that were asked to cancel but never acknowledged within
    /// `grace_secs`. A live agent acknowledges a cancel on its next progress or
    /// resolve call (which moves the task to `Canceled`); if that never happens
    /// the agent is presumed dead and the task is failed so it reaches a
    /// terminal state instead of hanging until the archive sweep.
    /// Returns the number of tasks that were failed.
    pub fn fail_stale_cancel_requested(&self, grace_secs: i64) -> Result<usize> {
        let now = Utc::now();
        let mut stuck: Vec<AssignedTask> = Vec::new();

        for item in self.assigned.iter() {
            let (_k, v) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&v)?;
            if task.status != TaskStatus::CancelRequested {
                continue;
            }
            let since = task.cancel_requested_at.unwrap_or(task.assigned_at);
            if (now - since).num_seconds() >= grace_secs {
                stuck.push(task);
            }
        }

        let count = stuck.len();
        for mut task in stuck {
            task.change_status(TaskStatus::Failed);
            task.stage = None;
            self.update_assigned(&task)?;
            info!(
                "Task {} cancel-requested but never acknowledged, marked failed",
                task.id
            );
        }

        Ok(count)
    }

    /// Recover tasks abandoned by a dead agent. A task is orphaned when it is in
    /// an active (non-terminal, non-cancel-requested) status, its assigned agent
    /// is offline, and it has not been touched for `silence_secs`. Such tasks are
    /// failed so they reach a terminal state. `is_agent_online` reports whether
    /// the agent that holds the task is currently online.
    /// Returns the number of tasks that were recovered.
    pub fn recover_orphaned_assigned<F>(
        &self,
        silence_secs: i64,
        is_agent_online: F,
    ) -> Result<usize>
    where
        F: Fn(&str) -> bool,
    {
        let now = Utc::now();
        let mut orphaned: Vec<AssignedTask> = Vec::new();

        for item in self.assigned.iter() {
            let (_k, v) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&v)?;
            // Only actively-held tasks can be orphaned. Terminal tasks are done;
            // CancelRequested is handled by fail_stale_cancel_requested.
            match task.status {
                TaskStatus::Assigned | TaskStatus::Starting | TaskStatus::Running => {}
                _ => continue,
            }
            if is_agent_online(&task.agent_id) {
                continue;
            }
            let last = task.last_update_at.unwrap_or(task.assigned_at);
            if (now - last).num_seconds() >= silence_secs {
                orphaned.push(task);
            }
        }

        let count = orphaned.len();
        for mut task in orphaned {
            let agent_id = task.agent_id.clone();
            task.change_status(TaskStatus::Failed);
            task.stage = None;
            task.append_log(Some(format!(
                "\n[server] Task failed: agent {} went offline and stopped reporting",
                agent_id
            )));
            self.update_assigned(&task)?;
            info!(
                "Task {} orphaned (agent {} offline and silent), marked failed",
                task.id, agent_id
            );
        }

        Ok(count)
    }

    pub fn list_assigned_all(&self) -> Result<Vec<AssignedTask>> {
        let mut result = Vec::new();
        // The iter() method returns an iterator over all key-value pairs in the tree.
        for item in self.assigned.iter() {
            // Each item is a sled::Result<(IVec, IVec)>
            let (_key, value) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&value)?;
            result.push(task);
        }
        Ok(result)
    }
}
