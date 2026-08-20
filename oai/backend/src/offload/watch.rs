//! Single persistent WebSocket connection to OffloadMQ's `GET /api/task/watch`
//! (see `docs/tasks-api.md`'s "Watch Tasks (WebSocket)" section on the server).
//!
//! Every OffloadMQ poll in this codebase used to be its own HTTP request; this
//! module replaces all of that with one shared connection per process. Callers
//! `track()` a task once (typically right after submit) and read its latest
//! known state via `get()`. [`crate::offload::OffloadClient::poll_task`] and
//! [`crate::offload::image_tasks::OffloadImageClient::poll_task`] are the only
//! two places that actually read the cache (via [`TaskWatch::get_or_track`]) —
//! every existing caller of those two methods gets the traffic reduction for
//! free, with no call-site changes required. Untracking is an optimization
//! (it keeps the tracked set, and therefore the update traffic the server
//! sends back, from growing without bound over a long-running process) rather
//! than a correctness requirement: a task nobody explicitly untracks just sits
//! in the cache being needlessly refreshed.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sea_orm::DatabaseConnection;
use tokio::sync::{broadcast, mpsc, Notify, RwLock};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

use crate::{db::app_settings, error::AppError, offload::task_status::OFFLOAD_TASK_MISSING};

const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How long [`TaskWatch::get_or_track`] waits for the first snapshot of a
/// newly-tracked task before giving up. The server ticks roughly every
/// second, so one second's worth of retries covers the common case.
const FIRST_SNAPSHOT_TIMEOUT: Duration = Duration::from_millis(1200);
const FIRST_SNAPSHOT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const EVENT_CHANNEL_CAPACITY: usize = 4096;

#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct TaskKey {
    pub cap: String,
    pub id: String,
}

impl TaskKey {
    pub fn new(cap: &str, id: &str) -> Self {
        Self { cap: cap.to_string(), id: id.to_string() }
    }
}

/// Latest known state of a tracked task. `None` fields mean "unset", not
/// "unknown" — a field is only `None` if the server hasn't reported a value
/// for it (e.g. `stage` before an agent picks the task up).
#[derive(Debug, Clone, Default)]
pub struct TaskSnapshot {
    pub status: Option<String>,
    pub stage: Option<String>,
    pub log: Option<String>,
    pub output: Option<serde_json::Value>,
    pub typical_runtime_seconds: Option<f64>,
    /// The task doesn't exist in any OffloadMQ store — the push equivalent of
    /// the old HTTP poll's 404.
    pub missing: bool,
}

enum WsCmd {
    Track(TaskKey),
    Untrack(TaskKey),
}

pub struct TaskWatch {
    tracked: RwLock<HashSet<TaskKey>>,
    cache: RwLock<HashMap<TaskKey, TaskSnapshot>>,
    cmd_tx: mpsc::UnboundedSender<WsCmd>,
    events: broadcast::Sender<TaskKey>,
    reconnect: Notify,
}

/// Manual, minimal impl: several fields (channels, the notify) don't carry
/// meaningful debug state of their own.
impl std::fmt::Debug for TaskWatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaskWatch").finish_non_exhaustive()
    }
}

impl TaskWatch {
    /// Spawn the connection-supervisor task and return the shared handle.
    pub fn spawn(db: DatabaseConnection) -> Arc<Self> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let watch = Arc::new(Self {
            tracked: RwLock::new(HashSet::new()),
            cache: RwLock::new(HashMap::new()),
            cmd_tx,
            events,
            reconnect: Notify::new(),
        });
        let supervised = watch.clone();
        tokio::spawn(async move { supervised.run(db, cmd_rx).await });
        watch
    }

    /// Add a task to the tracked set. Idempotent — re-tracking an already
    /// tracked task is a no-op beyond the insert.
    pub async fn track(&self, cap: &str, id: &str) {
        let key = TaskKey::new(cap, id);
        {
            let mut tracked = self.tracked.write().await;
            if !tracked.insert(key.clone()) {
                return;
            }
        }
        let _ = self.cmd_tx.send(WsCmd::Track(key));
    }

    /// Remove a task from the tracked set and drop its cached state.
    pub async fn untrack(&self, cap: &str, id: &str) {
        let key = TaskKey::new(cap, id);
        self.tracked.write().await.remove(&key);
        self.cache.write().await.remove(&key);
        let _ = self.cmd_tx.send(WsCmd::Untrack(key));
    }

    /// Read the latest cached state, if any.
    pub async fn get(&self, cap: &str, id: &str) -> Option<TaskSnapshot> {
        self.cache.read().await.get(&TaskKey::new(cap, id)).cloned()
    }

    /// Read the cached state, tracking the task first if nobody has yet.
    /// Waits briefly for the first snapshot to arrive so a caller that never
    /// explicitly tracked (a bespoke poller reaching this on its own
    /// schedule) still gets real data on its very next call rather than
    /// perpetually seeing "not yet observed".
    pub async fn get_or_track(&self, cap: &str, id: &str) -> Option<TaskSnapshot> {
        if let Some(snap) = self.get(cap, id).await {
            return Some(snap);
        }
        self.track(cap, id).await;
        let deadline = tokio::time::Instant::now() + FIRST_SNAPSHOT_TIMEOUT;
        loop {
            tokio::time::sleep(FIRST_SNAPSHOT_POLL_INTERVAL).await;
            if let Some(snap) = self.get(cap, id).await {
                return Some(snap);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
        }
    }

    /// Wakeups for tasks whose cached state just changed — background
    /// workers and WS poll loops can select on this instead of a fixed
    /// interval to react immediately.
    pub fn subscribe(&self) -> broadcast::Receiver<TaskKey> {
        self.events.subscribe()
    }

    /// Force the connection to drop and reconnect, e.g. after admin settings
    /// (OffloadMQ URL / API key) change at runtime.
    pub fn reconnect(&self) {
        self.reconnect.notify_one();
    }

    async fn run(
        self: Arc<Self>,
        db: DatabaseConnection,
        mut cmd_rx: mpsc::UnboundedReceiver<WsCmd>,
    ) {
        let mut backoff = MIN_BACKOFF;
        loop {
            match self.connect_and_serve(&db, &mut cmd_rx).await {
                Ok(()) => backoff = MIN_BACKOFF,
                Err(e) => {
                    tracing::warn!("task watch: connection error, retrying: {e}");
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {}
                _ = self.reconnect.notified() => {}
            }
        }
    }

    async fn connect_and_serve(
        &self,
        db: &DatabaseConnection,
        cmd_rx: &mut mpsc::UnboundedReceiver<WsCmd>,
    ) -> Result<(), anyhow::Error> {
        let settings = app_settings::get(db).await?;
        let api_key = settings.client_api_token.unwrap_or_default();
        if api_key.is_empty() {
            anyhow::bail!("no OffloadMQ client API token configured");
        }
        let ws_url = to_ws_url(&settings.offloadmq_url)?;

        let mut request = ws_url.into_client_request()?;
        request
            .headers_mut()
            .insert("X-API-Key", HeaderValue::from_str(&api_key)?);

        let (stream, _resp) = tokio_tungstenite::connect_async(request).await?;
        tracing::info!("task watch: connected to {}", settings.offloadmq_url);
        let (mut sink, mut source) = stream.split();

        // A fresh connection has no server-side state for us — re-track
        // everything we currently care about.
        let snapshot: Vec<TaskKey> = self.tracked.read().await.iter().cloned().collect();
        if !snapshot.is_empty() {
            send_frame(&mut sink, &track_frame(&snapshot)).await?;
        }

        loop {
            tokio::select! {
                _ = self.reconnect.notified() => {
                    return Ok(());
                }
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(WsCmd::Track(key)) => {
                            send_frame(&mut sink, &track_frame(std::slice::from_ref(&key))).await?;
                        }
                        Some(WsCmd::Untrack(key)) => {
                            send_frame(&mut sink, &untrack_frame(std::slice::from_ref(&key))).await?;
                        }
                        None => return Ok(()),
                    }
                }
                msg = source.next() => {
                    match msg {
                        Some(Ok(Message::Text(text))) => {
                            self.apply_frame(&text).await;
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            anyhow::bail!("connection closed by server");
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => return Err(e.into()),
                    }
                }
            }
        }
    }

    async fn apply_frame(&self, text: &str) {
        tracing::debug!("task watch: << {text}");
        let frame = match serde_json::from_str::<ServerFrame>(text) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("task watch: failed to parse frame: {e}: {text}");
                return;
            }
        };
        let ServerFrame::Update { tasks, .. } = frame else {
            return;
        };
        let mut cache = self.cache.write().await;
        for entry in tasks {
            let key = TaskKey::new(&entry.id.cap, &entry.id.id);
            let slot = cache.entry(key.clone()).or_default();
            if entry.missing {
                slot.missing = true;
            } else {
                slot.missing = false;
                if let Some(status) = entry.status {
                    slot.status = Some(status);
                }
                if let Some(stage) = entry.stage {
                    slot.stage = Some(stage);
                }
                if let Some(log) = entry.log {
                    slot.log = Some(log);
                } else if let Some(append) = entry.log_append {
                    let existing = slot.log.get_or_insert_with(String::new);
                    existing.push_str(&append);
                }
                if let Some(output) = entry.output {
                    slot.output = Some(output);
                }
                if entry.typical_runtime_seconds.is_some() {
                    slot.typical_runtime_seconds = entry.typical_runtime_seconds;
                }
            }
            let _ = self.events.send(key);
        }
    }
}

/// Fields shared by `offload::PollResponse` and
/// `offload::image_tasks::OffloadPollResponse` — [`poll_via_watch`] returns
/// this once and each concrete client converts it to its own type.
pub struct PolledFields {
    pub status: String,
    pub stage: Option<String>,
    pub output: Option<serde_json::Value>,
    pub log: Option<String>,
    pub typical_runtime_seconds: Option<Duration>,
}

/// Shared implementation of `OffloadClient::poll_task` /
/// `OffloadImageClient::poll_task`: read the watch cache instead of issuing an
/// HTTP request. Preserves the pre-existing error convention so
/// `offload_task_missing_message` and every caller that already checks it
/// keep working unmodified — only *how* the answer is obtained changed.
pub async fn poll_via_watch(watch: &TaskWatch, cap: &str, id: &str) -> Result<PolledFields, AppError> {
    match watch.get_or_track(cap, id).await {
        Some(snap) if snap.missing => {
            Err(AppError::ExternalService(format!("POLL_HTTP_404:{OFFLOAD_TASK_MISSING}")))
        }
        Some(snap) => Ok(PolledFields {
            status: snap.status.unwrap_or_else(|| "pending".to_string()),
            stage: snap.stage,
            output: snap.output,
            log: snap.log,
            typical_runtime_seconds: snap.typical_runtime_seconds.map(Duration::from_secs_f64),
        }),
        None => Err(AppError::ExternalService(
            "WATCH_PENDING: task not yet observed by the watch cache".to_string(),
        )),
    }
}

fn to_ws_url(http_url: &str) -> Result<String, anyhow::Error> {
    let trimmed = http_url.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        Ok(format!("wss://{rest}/api/task/watch"))
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        Ok(format!("ws://{rest}/api/task/watch"))
    } else {
        anyhow::bail!("offloadmq_url has no http(s) scheme: {http_url}")
    }
}

async fn send_frame(
    sink: &mut (impl futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    frame: &ClientFrame,
) -> Result<(), anyhow::Error> {
    let payload = serde_json::to_string(frame)?;
    tracing::debug!("task watch: >> {payload}");
    sink.send(Message::Text(payload.into())).await?;
    Ok(())
}

fn track_frame(tasks: &[TaskKey]) -> ClientFrame {
    ClientFrame::Track { req_id: "oai".to_string(), tasks: tasks.to_vec() }
}

fn untrack_frame(tasks: &[TaskKey]) -> ClientFrame {
    ClientFrame::Untrack { req_id: "oai".to_string(), tasks: tasks.to_vec() }
}

// ---------------------------------------------------------------------------
// Wire protocol (mirrors src/api/client/watch.rs on the server)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ClientFrame {
    Track { req_id: String, tasks: Vec<TaskKey> },
    Untrack { req_id: String, tasks: Vec<TaskKey> },
}

impl Serialize for TaskKey {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("TaskKey", 2)?;
        st.serialize_field("cap", &self.cap)?;
        st.serialize_field("id", &self.id)?;
        st.end()
    }
}

#[derive(Debug, Deserialize)]
struct WireTaskId {
    cap: String,
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireTaskEntry {
    id: WireTaskId,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    log: Option<String>,
    #[serde(default)]
    log_append: Option<String>,
    #[serde(default)]
    output: Option<serde_json::Value>,
    #[serde(default)]
    typical_runtime_seconds: Option<f64>,
    #[serde(default)]
    missing: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerFrame {
    Hello,
    Ack,
    Update {
        tasks: Vec<WireTaskEntry>,
    },
    Error,
    Pong,
}
