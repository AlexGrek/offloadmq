use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, watch};

use crate::{
    config::AppConfig,
    db::{app_storage::AppStorage, service_message_storage::ServiceMessage},
    middleware::auth::Auth,
    mq::{registry::AgentRegistry, regular::RegularTaskStore, urgent::UrgentTaskStore},
    schema::{TaskId, TaskResultStatus, TaskStatus},
};

const STREAM_BROADCAST_CAPACITY: usize = 256;
const DB_WRITE_QUEUE_CAPACITY: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    ServiceMessage(ServiceMessage),
    TaskLifecycle(TaskLifecycleEvent),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskQueueKind {
    Urgent,
    Regular,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLifecycleEvent {
    pub task_id: TaskId,
    pub queue: TaskQueueKind,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<TaskStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_status: Option<TaskResultStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
}

#[derive(Debug, Clone)]
pub enum DbWriteRequest {
    ServiceMessage {
        class: String,
        kind: String,
        content: Value,
    },
}

#[derive(Clone)]
pub struct AppChannels {
    pub stream_tx: broadcast::Sender<StreamEvent>,
    pub db_write_tx: mpsc::Sender<DbWriteRequest>,
    pub shutdown_tx: watch::Sender<bool>,
}

pub struct AppWorkers {
    pub db_write_rx: mpsc::Receiver<DbWriteRequest>,
    pub shutdown_rx: watch::Receiver<bool>,
}

impl AppChannels {
    pub fn new() -> (Self, AppWorkers) {
        let (stream_tx, _) = broadcast::channel(STREAM_BROADCAST_CAPACITY);
        let (db_write_tx, db_write_rx) = mpsc::channel(DB_WRITE_QUEUE_CAPACITY);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        (
            Self {
                stream_tx,
                db_write_tx,
                shutdown_tx,
            },
            AppWorkers {
                db_write_rx,
                shutdown_rx,
            },
        )
    }
}

#[derive(Clone)]
pub struct AppState {
    pub storage: Arc<AppStorage>,
    pub config: Arc<AppConfig>,
    pub auth: Arc<Auth>,
    pub urgent: Arc<UrgentTaskStore>,
    pub regular: Arc<RegularTaskStore>,
    /// Live agent WebSocket connections, enabling server-initiated task push.
    pub registry: Arc<AgentRegistry>,
    pub channels: AppChannels,
    /// Serializes bucket validation + reservation during task submission so two
    /// concurrent submissions can't both pass the `rm_after_task` single-use
    /// check before either records its task id (TOCTOU).
    pub bucket_submit_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    pub fn new(storage: AppStorage, config: AppConfig, auth: Auth, channels: AppChannels) -> Self {
        Self {
            storage: Arc::new(storage),
            config: Arc::new(config),
            auth: Arc::new(auth),
            urgent: UrgentTaskStore::new(),
            regular: RegularTaskStore::new(),
            registry: AgentRegistry::new(),
            channels,
            bucket_submit_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    pub fn subscribe_stream(&self) -> broadcast::Receiver<StreamEvent> {
        self.channels.stream_tx.subscribe()
    }

    pub fn subscribe_shutdown(&self) -> watch::Receiver<bool> {
        self.channels.shutdown_tx.subscribe()
    }
}
