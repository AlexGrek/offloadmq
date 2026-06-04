//! Registry of live agent WebSocket connections.
//!
//! This is the delivery mechanism that turns the agent WebSocket from a
//! poll-over-a-socket RPC pipe into a push channel: it lets code anywhere in the
//! server (task submission, the dispatcher, cancellation) hand a message to a
//! specific connected agent.
//!
//! Design notes:
//! - Keyed on the full `agent.uid` (not `uid_short`), matching all scheduling code.
//! - The registry holds **no** agent metadata (tier/capabilities/capacity). Those
//!   are read live from `AgentStorage` at dispatch time so `info/update` changes
//!   are always honored — the registry is purely "uid -> how to reach it".
//! - Every method is synchronous and must never hold a lock across `.await`.
//!   The idiom for senders is: lock -> clone `Sender` -> drop guard -> `.await`/`try_send`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::schema::TaskId;

/// Channel depth for a connection's outbound queue. Small on purpose: a wedged
/// (alive-but-not-draining) socket fills this quickly, and the dispatcher's
/// `try_send` then reports `Full`, which we treat as "unhealthy, tear it down"
/// rather than blocking a submit.
pub const WS_OUT_CHANNEL_CAPACITY: usize = 64;

/// Outbound message destined for an agent's WebSocket connection. The connection's
/// dedicated writer task owns the socket sink and is the sole producer of frames;
/// everything else (the response path, heartbeat, dispatcher pushes) enqueues
/// `WsOut` values onto the connection's channel.
#[derive(Debug, Clone)]
pub enum WsOut {
    Text(String),
    Binary(Vec<u8>),
    /// Ask the writer task to close the socket and exit.
    Close,
}

/// A live agent WebSocket connection.
pub struct AgentConn {
    /// Feeds the connection's writer task.
    pub tx: mpsc::Sender<WsOut>,
    /// Tasks currently pushed to / held by this connection and not yet terminal.
    /// Drained on disconnect to decide which tasks to re-queue (only un-started
    /// ones). The capacity gate no longer reads this — that count is now the
    /// uid-keyed [`crate::mq::agent_load::AgentLoad`], which cannot leak.
    pub assigned: Arc<Mutex<HashSet<TaskId>>>,
    /// Disambiguates reconnects so a slow old-socket teardown can't evict a newer one.
    pub conn_id: u64,
}

pub struct AgentRegistry {
    conns: Mutex<HashMap<String, AgentConn>>,
    next_conn_id: AtomicU64,
}

impl AgentRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            conns: Mutex::new(HashMap::new()),
            next_conn_id: AtomicU64::new(1),
        })
    }

    /// Register a new connection for `uid`. If a previous connection exists for
    /// the same uid (a reconnect that raced ahead of the old socket's teardown),
    /// it is evicted: the old writer is told to `Close` and dropped. Returns the
    /// new `conn_id` and the shared `assigned` set for this connection.
    pub fn register(
        &self,
        uid: &str,
        tx: mpsc::Sender<WsOut>,
    ) -> (u64, Arc<Mutex<HashSet<TaskId>>>) {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::SeqCst);
        let assigned = Arc::new(Mutex::new(HashSet::new()));
        let conn = AgentConn {
            tx,
            assigned: Arc::clone(&assigned),
            conn_id,
        };
        let evicted = {
            let mut guard = self.conns.lock().unwrap();
            guard.insert(uid.to_string(), conn)
        };
        if let Some(old) = evicted {
            // Best-effort: nudge the superseded connection's writer to close.
            let _ = old.tx.try_send(WsOut::Close);
        }
        (conn_id, assigned)
    }

    /// Remove the connection for `uid` only if it still has `conn_id`. Guards
    /// against a slow teardown of an old socket evicting a newer reconnect.
    pub fn deregister(&self, uid: &str, conn_id: u64) {
        let mut guard = self.conns.lock().unwrap();
        if guard
            .get(uid)
            .is_some_and(|existing| existing.conn_id == conn_id)
        {
            guard.remove(uid);
        }
    }

    /// Clone the outbound sender for `uid`, if connected. Callers `try_send` on it
    /// after dropping the registry lock (the clone makes that safe).
    pub fn sender(&self, uid: &str) -> Option<mpsc::Sender<WsOut>> {
        self.conns.lock().unwrap().get(uid).map(|c| c.tx.clone())
    }

    pub fn is_connected(&self, uid: &str) -> bool {
        self.conns.lock().unwrap().contains_key(uid)
    }

    pub fn connected_uids(&self) -> Vec<String> {
        self.conns.lock().unwrap().keys().cloned().collect()
    }

    /// Record that `task_id` is held by `uid`'s connection (no-op if not connected).
    pub fn track_assigned(&self, uid: &str, task_id: TaskId) {
        let guard = self.conns.lock().unwrap();
        if let Some(c) = guard.get(uid) {
            c.assigned.lock().unwrap().insert(task_id);
        }
    }

    /// Stop tracking `task_id` for `uid`'s connection (terminal / resolved / reverted).
    pub fn untrack_assigned(&self, uid: &str, task_id: &TaskId) {
        let guard = self.conns.lock().unwrap();
        if let Some(c) = guard.get(uid) {
            c.assigned.lock().unwrap().remove(task_id);
        }
    }
}
