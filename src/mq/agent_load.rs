//! Authoritative per-agent in-flight load, keyed by agent **uid**.
//!
//! This is the capacity gate's source of truth for "how many non-terminal tasks
//! does agent X currently hold". It exists to replace the previous gate, which
//! counted entries in a per-WebSocket-connection set
//! ([`crate::mq::registry::AgentConn::assigned`]). That counter leaked: a task
//! driven terminal by a sweep (timeout / cancel-escalation / orphan recovery) or
//! a `resolve` that early-returned was never untracked, permanently pinning the
//! count at/above capacity and starving the agent of all future dispatch.
//!
//! Design:
//! - Keyed on `agent.uid` (not on a connection), so it survives reconnects — a
//!   reconnect can no longer reset the count to 0 while the agent is still
//!   running a task (which previously caused over-dispatch beyond capacity).
//! - Updated incrementally on assign / release for prompt dispatch, and
//!   **reconciled from the persistent task store every 30s** (see
//!   [`reconcile`](AgentLoad::reconcile)). The reconcile is the correctness
//!   guarantee: any incremental miss self-heals within one sweep because the
//!   store — where every terminal transition is recorded — is authoritative.
//! - Synchronous; never holds the lock across `.await` (same discipline as
//!   [`crate::mq::registry::AgentRegistry`]).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::schema::TaskId;

pub struct AgentLoad {
    /// uid -> set of non-terminal task ids currently owned by that agent.
    inner: Mutex<HashMap<String, HashSet<TaskId>>>,
}

impl AgentLoad {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
        })
    }

    /// Record that `task_id` is now held by `uid` (incremental, on take).
    pub fn assigned(&self, uid: &str, task_id: TaskId) {
        let mut guard = self.inner.lock().unwrap();
        guard.entry(uid.to_string()).or_default().insert(task_id);
    }

    /// Stop counting `task_id` against `uid` (incremental, on any terminal
    /// outcome). Prunes the agent's entry once it holds nothing.
    pub fn released(&self, uid: &str, task_id: &TaskId) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(set) = guard.get_mut(uid) {
            set.remove(task_id);
            if set.is_empty() {
                guard.remove(uid);
            }
        }
    }

    /// Number of non-terminal tasks currently held by `uid` (the capacity gate).
    pub fn in_flight(&self, uid: &str) -> usize {
        self.inner
            .lock()
            .unwrap()
            .get(uid)
            .map(|s| s.len())
            .unwrap_or(0)
    }

    /// Replace the whole map from the source of truth. `live` must be computed
    /// from the persistent assigned store (+ urgent store), counting only
    /// non-terminal tasks grouped by their owning agent uid. Callers build
    /// `live` before taking the lock so this is a cheap swap.
    ///
    /// Safe against the assign race because [`crate::api::agent::service::take_task`]
    /// writes the assignment to the store *before* calling [`assigned`](Self::assigned):
    /// any snapshot taken after a freshly-assigned task became visible to
    /// `assigned` also observed the prior store write, so a live task is never
    /// dropped.
    pub fn reconcile(&self, live: HashMap<String, HashSet<TaskId>>) {
        *self.inner.lock().unwrap() = live;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tid(cap: &str, id: &str) -> TaskId {
        TaskId {
            cap: cap.to_string(),
            id: id.to_string(),
        }
    }

    #[test]
    fn assign_and_release_counts() {
        let load = AgentLoad::new();
        assert_eq!(load.in_flight("a"), 0);

        load.assigned("a", tid("llm", "1"));
        load.assigned("a", tid("llm", "2"));
        assert_eq!(load.in_flight("a"), 2);

        load.released("a", &tid("llm", "1"));
        assert_eq!(load.in_flight("a"), 1);

        load.released("a", &tid("llm", "2"));
        assert_eq!(load.in_flight("a"), 0);
    }

    #[test]
    fn assign_is_idempotent_per_task() {
        let load = AgentLoad::new();
        load.assigned("a", tid("llm", "1"));
        load.assigned("a", tid("llm", "1"));
        assert_eq!(load.in_flight("a"), 1);
    }

    #[test]
    fn release_unknown_is_noop() {
        let load = AgentLoad::new();
        load.released("a", &tid("llm", "1"));
        assert_eq!(load.in_flight("a"), 0);
    }

    #[test]
    fn reconcile_drops_phantom_leaked_slot() {
        let load = AgentLoad::new();
        // Two tasks tracked, but one was terminated by a sweep and never released
        // (the leak this whole module exists to prevent).
        load.assigned("a", tid("llm", "1"));
        load.assigned("a", tid("llm", "2"));
        assert_eq!(load.in_flight("a"), 2);

        // Source of truth says only task 1 is still non-terminal for agent "a".
        let mut live: HashMap<String, HashSet<TaskId>> = HashMap::new();
        live.insert("a".to_string(), HashSet::from([tid("llm", "1")]));
        load.reconcile(live);

        assert_eq!(load.in_flight("a"), 1); // phantom slot reclaimed
    }

    #[test]
    fn reconcile_clears_agent_with_no_live_tasks() {
        let load = AgentLoad::new();
        load.assigned("a", tid("llm", "1"));
        load.reconcile(HashMap::new());
        assert_eq!(load.in_flight("a"), 0);
    }
}
