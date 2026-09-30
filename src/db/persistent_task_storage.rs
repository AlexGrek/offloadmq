use std::collections::HashSet;

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

/// How long a finished task stays in the live `assigned` tree before archiving.
const ARCHIVE_RETENTION_DAYS: i64 = 7;
/// Tasks moved per flush by the archive sweep (bounds its memory use).
const ARCHIVE_BATCH: usize = 200;

/// Which assigned tasks a bounded listing should include.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AssignedStatusFilter {
    /// Non-terminal tasks only (queued-for-agent, starting, running, cancelling).
    Active,
    /// Completed / failed / canceled only.
    Terminal,
    #[default]
    All,
}

impl AssignedStatusFilter {
    fn matches(self, status: &TaskStatus) -> bool {
        match self {
            Self::Active => !status.is_terminal(),
            Self::Terminal => status.is_terminal(),
            Self::All => true,
        }
    }
}

/// Most recent moment anything happened to an assigned task; used to order and
/// time-filter listings.
fn activity_time(task: &AssignedTask) -> chrono::DateTime<Utc> {
    task.finished_at
        .or(task.last_update_at)
        .unwrap_or(task.assigned_at)
}

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
    ///
    /// Tasks are moved in bounded batches while streaming the tree, so memory
    /// stays flat however large the backlog is. Returns how many were archived.
    pub fn archive_stale_tasks(&self) -> Result<usize> {
        self.archive_stale_tasks_in_batches(ARCHIVE_BATCH)
    }

    fn archive_stale_tasks_in_batches(&self, batch_size: usize) -> Result<usize> {
        let cutoff = Utc::now() - chrono::Duration::days(ARCHIVE_RETENTION_DAYS);
        let mut archived = 0;
        let mut batch: Vec<(sled::IVec, sled::IVec)> = Vec::with_capacity(batch_size);

        for item in self.assigned.iter() {
            let (k, v) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&v)?;
            let retain_from = task.finished_at.unwrap_or(task.assigned_at);
            if task.status.is_terminal() && retain_from < cutoff {
                batch.push((k, v));
                if batch.len() >= batch_size {
                    archived += self.flush_archive_batch(&mut batch)?;
                }
            }
        }
        archived += self.flush_archive_batch(&mut batch)?;
        Ok(archived)
    }

    /// Insert into the archive before removing from `assigned`, so a crash
    /// between the two leaves a duplicate (harmless, re-archived next sweep)
    /// rather than a lost task.
    fn flush_archive_batch(&self, batch: &mut Vec<(sled::IVec, sled::IVec)>) -> Result<usize> {
        let n = batch.len();
        for (k, v) in batch.drain(..) {
            self.archived.insert(&k, v)?;
            self.assigned.remove(&k)?;
        }
        Ok(n)
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

    /// Task ids `agent_id` still holds in a non-terminal state that the agent
    /// itself no longer claims.
    ///
    /// Agents report the set of tasks they are actually running with every
    /// heartbeat. A task missing from that set is a **desync**: the agent
    /// finished it but the resolve never reached the server (a socket that
    /// dropped mid-upload is the usual way), the agent process restarted and
    /// forgot it, or its executor died. Left alone such a task holds the
    /// agent's capacity slot forever and the agent is never dispatched to
    /// again, so it must be reclaimed.
    ///
    /// `grace_secs` covers the one benign gap: a task pushed to the agent while
    /// a heartbeat whose snapshot predates it was already in flight. Only tasks
    /// untouched for at least that long are reported.
    pub fn list_disowned_assigned(
        &self,
        agent_id: &str,
        claimed: &HashSet<TaskId>,
        grace_secs: i64,
    ) -> Result<Vec<TaskId>> {
        let now = Utc::now();
        let mut disowned: Vec<TaskId> = Vec::new();

        for item in self.assigned.iter() {
            let (_k, v) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&v)?;
            if task.agent_id != agent_id {
                continue;
            }
            // Only actively-held tasks can be disowned. Terminal ones are done;
            // CancelRequested is handled by `fail_stale_cancel_requested`.
            match task.status {
                TaskStatus::Assigned | TaskStatus::Starting | TaskStatus::Running => {}
                _ => continue,
            }
            if claimed.contains(&task.id) {
                continue;
            }
            let last = task
                .last_update_at
                .unwrap_or(task.assigned_at)
                .max(task.assigned_at);
            if (now - last).num_seconds() >= grace_secs {
                disowned.push(task.id);
            }
        }

        Ok(disowned)
    }

    /// Fail one assigned task because the agent holding it no longer reports it
    /// as running. Returns `false` if the task is gone or already terminal — a
    /// resolve that landed between the scan and now wins, and nothing is
    /// overwritten.
    pub fn fail_disowned_assigned(&self, id: &TaskId, agent_id: &str) -> Result<bool> {
        let mut task = match self.get_assigned(id)? {
            Some(t) => t,
            None => return Ok(false),
        };
        if task.status.is_terminal() {
            return Ok(false);
        }
        task.change_status(TaskStatus::Failed);
        task.stage = None;
        task.append_log(Some(format!(
            "\n[server] Task failed: agent {} no longer reports it as running (result lost in transit)",
            agent_id
        )));
        self.update_assigned(&task)?;
        info!("Task {} disowned by agent {}, marked failed", id, agent_id);
        Ok(true)
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

    /// Non-terminal assigned tasks, streamed so finished history is never held
    /// in memory. Backs the agent-load reconcile tick.
    pub fn list_active_assigned(&self) -> Result<Vec<AssignedTask>> {
        let mut result = Vec::new();
        for item in self.assigned.iter() {
            let (_key, value) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&value)?;
            if !task.status.is_terminal() {
                result.push(task);
            }
        }
        Ok(result)
    }

    /// Bounded listing for the management API: the `limit` most recently active
    /// assigned tasks matching `status` (and not older than `since`), newest
    /// first, plus the total number that matched. Only ~2×`limit` tasks are
    /// ever held in memory, regardless of how many are stored.
    pub fn list_assigned_filtered(
        &self,
        status: AssignedStatusFilter,
        since: Option<chrono::DateTime<Utc>>,
        limit: usize,
    ) -> Result<(Vec<AssignedTask>, usize)> {
        let mut kept: Vec<AssignedTask> = Vec::new();
        let mut total = 0usize;
        let newest_first =
            |a: &AssignedTask, b: &AssignedTask| activity_time(b).cmp(&activity_time(a));

        for item in self.assigned.iter() {
            let (_key, value) = item?;
            let task: AssignedTask = rmp_serde::from_slice(&value)?;
            if !status.matches(&task.status) || since.is_some_and(|s| activity_time(&task) < s) {
                continue;
            }
            total += 1;
            kept.push(task);
            if kept.len() >= limit.saturating_mul(2).max(1) {
                kept.sort_by(newest_first);
                kept.truncate(limit);
            }
        }
        kept.sort_by(newest_first);
        kept.truncate(limit);
        Ok((kept, total))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TaskEvent;
    use crate::schema::TaskSubmissionRequest;
    use chrono::TimeDelta;

    /// Minimal scoped temp directory — sled needs a real path and the crate has
    /// no dev-dependency on `tempfile`.
    struct TempDirGuard(std::path::PathBuf);

    impl TempDirGuard {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "offloadmq-tasks-test-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }

        fn path(&self) -> &str {
            self.0.to_str().expect("utf-8 temp path")
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn storage() -> (TaskStorage, TempDirGuard) {
        let guard = TempDirGuard::new();
        let store = TaskStorage::open(guard.path()).expect("open task storage");
        (store, guard)
    }

    /// An assigned task owned by `agent`, in `status`, last touched `age_secs` ago.
    fn assigned(agent: &str, id: &str, status: TaskStatus, age_secs: i64) -> AssignedTask {
        let then = Utc::now() - TimeDelta::seconds(age_secs);
        AssignedTask {
            id: TaskId {
                cap: "test.cap".into(),
                id: id.into(),
            },
            data: TaskSubmissionRequest {
                capability: "test.cap".into(),
                ..Default::default()
            },
            agent_id: agent.into(),
            status,
            created_at: then,
            assigned_at: then,
            last_update_at: Some(then),
            history: vec![TaskEvent {
                timestamp: then,
                description: "Assigned".into(),
            }],
            ..AssignedTask::default()
        }
    }

    fn tid(id: &str) -> TaskId {
        TaskId {
            cap: "test.cap".into(),
            id: id.into(),
        }
    }

    #[test]
    fn reports_only_tasks_the_agent_stopped_claiming() {
        let (store, _guard) = storage();
        store
            .update_assigned(&assigned("a1", "claimed", TaskStatus::Running, 600))
            .unwrap();
        store
            .update_assigned(&assigned("a1", "lost", TaskStatus::Running, 600))
            .unwrap();
        // Another agent's task must never be reclaimed from this heartbeat.
        store
            .update_assigned(&assigned("a2", "other", TaskStatus::Running, 600))
            .unwrap();

        let claimed = HashSet::from([tid("claimed")]);
        let disowned = store.list_disowned_assigned("a1", &claimed, 120).unwrap();
        assert_eq!(disowned, vec![tid("lost")]);
    }

    #[test]
    fn grace_protects_a_freshly_pushed_task() {
        let (store, _guard) = storage();
        // Pushed 5s ago: a heartbeat whose snapshot predates the push legitimately
        // omits it, so it must survive.
        store
            .update_assigned(&assigned("a1", "fresh", TaskStatus::Assigned, 5))
            .unwrap();

        let empty = HashSet::new();
        assert!(
            store
                .list_disowned_assigned("a1", &empty, 120)
                .unwrap()
                .is_empty()
        );
        // …and is reclaimed once it has been quiet past the grace window.
        assert_eq!(
            store.list_disowned_assigned("a1", &empty, 1).unwrap(),
            vec![tid("fresh")]
        );
    }

    #[test]
    fn terminal_and_cancel_requested_tasks_are_left_alone() {
        let (store, _guard) = storage();
        store
            .update_assigned(&assigned("a1", "done", TaskStatus::Completed, 600))
            .unwrap();
        store
            .update_assigned(&assigned("a1", "failed", TaskStatus::Failed, 600))
            .unwrap();
        store
            .update_assigned(&assigned(
                "a1",
                "cancelling",
                TaskStatus::CancelRequested,
                600,
            ))
            .unwrap();

        let empty = HashSet::new();
        assert!(
            store
                .list_disowned_assigned("a1", &empty, 120)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn failing_a_disowned_task_is_terminal_and_idempotent() {
        let (store, _guard) = storage();
        store
            .update_assigned(&assigned("a1", "lost", TaskStatus::Running, 600))
            .unwrap();

        assert!(store.fail_disowned_assigned(&tid("lost"), "a1").unwrap());
        let task = store.get_assigned(&tid("lost")).unwrap().unwrap();
        assert_eq!(task.status, TaskStatus::Failed);
        assert!(task.finished_at.is_some());
        assert!(task.log.unwrap().contains("no longer reports it"));

        // A second pass (or a resolve that already landed) must not rewrite it.
        assert!(!store.fail_disowned_assigned(&tid("lost"), "a1").unwrap());
        assert!(!store.fail_disowned_assigned(&tid("missing"), "a1").unwrap());
    }

    const DAY: i64 = 24 * 60 * 60;

    #[test]
    fn archive_moves_only_old_terminal_tasks() {
        let (store, _guard) = storage();
        store
            .update_assigned(&assigned("a1", "old-done", TaskStatus::Completed, 8 * DAY))
            .unwrap();
        store
            .update_assigned(&assigned("a1", "new-done", TaskStatus::Completed, DAY))
            .unwrap();
        store
            .update_assigned(&assigned("a1", "old-running", TaskStatus::Running, 8 * DAY))
            .unwrap();

        assert_eq!(store.archive_stale_tasks().unwrap(), 1);
        assert!(store.get_assigned(&tid("old-done")).unwrap().is_none());
        assert!(store.get_assigned(&tid("new-done")).unwrap().is_some());
        assert!(store.get_assigned(&tid("old-running")).unwrap().is_some());
        assert_eq!(store.archived.len(), 1);
        // Idempotent: nothing left to archive.
        assert_eq!(store.archive_stale_tasks().unwrap(), 0);
    }

    #[test]
    fn archive_drains_a_backlog_larger_than_one_batch() {
        let (store, _guard) = storage();
        for i in 0..25 {
            store
                .update_assigned(&assigned(
                    "a1",
                    &format!("old-{i}"),
                    TaskStatus::Failed,
                    9 * DAY,
                ))
                .unwrap();
        }
        store
            .update_assigned(&assigned("a1", "keep", TaskStatus::Completed, 60))
            .unwrap();

        assert_eq!(store.archive_stale_tasks_in_batches(4).unwrap(), 25);
        assert_eq!(store.archived.len(), 25);
        assert_eq!(store.assigned.len(), 1);
    }

    #[test]
    fn filtered_listing_is_bounded_newest_first_and_counts_total() {
        let (store, _guard) = storage();
        for i in 0..10 {
            // i = 0 is the newest (10s old), i = 9 the oldest (100s old).
            store
                .update_assigned(&assigned(
                    "a1",
                    &format!("done-{i}"),
                    TaskStatus::Completed,
                    10 * (i + 1),
                ))
                .unwrap();
        }
        store
            .update_assigned(&assigned("a1", "live", TaskStatus::Running, 500))
            .unwrap();

        let (tasks, total) = store
            .list_assigned_filtered(AssignedStatusFilter::All, None, 3)
            .unwrap();
        assert_eq!(total, 11);
        let ids: Vec<_> = tasks.iter().map(|t| t.id.id.as_str()).collect();
        assert_eq!(ids, ["done-0", "done-1", "done-2"]);

        let (active, total) = store
            .list_assigned_filtered(AssignedStatusFilter::Active, None, 50)
            .unwrap();
        assert_eq!((active.len(), total), (1, 1));
        assert_eq!(active[0].id.id, "live");

        let (terminal, total) = store
            .list_assigned_filtered(AssignedStatusFilter::Terminal, None, 50)
            .unwrap();
        assert_eq!((terminal.len(), total), (10, 10));

        let since = Utc::now() - TimeDelta::seconds(35);
        let (recent, total) = store
            .list_assigned_filtered(AssignedStatusFilter::All, Some(since), 50)
            .unwrap();
        assert_eq!((recent.len(), total), (3, 3));
    }

    #[test]
    fn active_listing_skips_finished_history() {
        let (store, _guard) = storage();
        store
            .update_assigned(&assigned("a1", "done", TaskStatus::Completed, 60))
            .unwrap();
        store
            .update_assigned(&assigned("a1", "live", TaskStatus::Running, 60))
            .unwrap();
        let active = store.list_active_assigned().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id.id, "live");
    }
}
