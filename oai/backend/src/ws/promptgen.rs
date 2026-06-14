//! WebSocket transport for the prompt generator: connection upgrade, ping/idle
//! management, frame decoding, and command dispatch. Domain logic lives in
//! `services::promptgen`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::StreamExt;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::time::interval;

use crate::middleware::AuthenticatedUser;
use crate::offload::TaskId;
use crate::services::{offload_factory, promptgen};
use crate::state::AppState;
use crate::ws::events::{PromptGenClientCommand, ServerEvent};

const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Tracks in-flight OffloadMQ tasks for one WS connection so they can be
/// canceled when the client disconnects or closes the prompt generator modal.
pub struct ConnectionScope {
    open: AtomicBool,
    tasks: Mutex<Vec<TaskId>>,
}

impl ConnectionScope {
    fn new() -> Self {
        Self {
            open: AtomicBool::new(true),
            tasks: Mutex::new(Vec::new()),
        }
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    pub fn track(&self, task: TaskId) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.push(task);
        }
    }

    pub fn untrack(&self, task: &TaskId) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.retain(|t| t.cap != task.cap || t.id != task.id);
        }
    }

    fn close(&self) {
        self.open.store(false, Ordering::SeqCst);
    }

    async fn cancel_tracked(&self, state: &AppState) {
        let tasks: Vec<TaskId> = self
            .tasks
            .lock()
            .map(|mut t| std::mem::take(&mut *t))
            .unwrap_or_default();
        if tasks.is_empty() {
            return;
        }
        if let Ok(client) = offload_factory::chat_client(state).await {
            for task in tasks {
                let _ = client.cancel_task(&task).await;
            }
        }
    }
}

pub async fn ws_promptgen(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Response {
    ws.on_upgrade(move |socket| run_connection(socket, state, user_id))
}

async fn run_connection(socket: WebSocket, state: Arc<AppState>, user_id: i64) {
    let scope = Arc::new(ConnectionScope::new());
    let (tx, rx) = unbounded_channel::<ServerEvent>();
    let _ = tx.send(ServerEvent::Hello { user_id });

    let (sink, stream) = socket.split();

    let writer = tokio::spawn(writer_loop(sink, rx));
    let reader = tokio::spawn(reader_loop(stream, tx, state.clone(), user_id, scope.clone()));
    let writer_abort = writer.abort_handle();
    let reader_abort = reader.abort_handle();

    tokio::select! {
        _ = writer => { reader_abort.abort(); }
        _ = reader => { writer_abort.abort(); }
    }

    scope.close();
    scope.cancel_tracked(&state).await;
}

async fn writer_loop(
    mut sink: futures::stream::SplitSink<WebSocket, Message>,
    mut rx: UnboundedReceiver<ServerEvent>,
) {
    use futures::SinkExt;
    let mut ticker = interval(PING_INTERVAL);
    ticker.tick().await;
    loop {
        tokio::select! {
            maybe_evt = rx.recv() => {
                let Some(evt) = maybe_evt else { return; };
                let Ok(payload) = serde_json::to_string(&evt) else { continue; };
                if sink.send(Message::Text(payload.into())).await.is_err() {
                    return;
                }
            }
            _ = ticker.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
        }
    }
}

async fn reader_loop(
    mut stream: futures::stream::SplitStream<WebSocket>,
    tx: UnboundedSender<ServerEvent>,
    state: Arc<AppState>,
    user_id: i64,
    scope: Arc<ConnectionScope>,
) {
    use tokio::time::Instant;
    let mut last_activity = Instant::now();

    loop {
        let deadline = last_activity + IDLE_TIMEOUT;
        let timeout = tokio::time::sleep_until(deadline);
        tokio::pin!(timeout);

        let frame = tokio::select! {
            frame = stream.next() => frame,
            _ = &mut timeout => {
                tracing::debug!("promptgen ws idle timeout user={user_id}");
                return;
            }
        };

        let msg = match frame {
            Some(Ok(m)) => m,
            _ => return,
        };
        last_activity = Instant::now();

        match msg {
            Message::Text(text) => {
                handle_text(text.as_str(), &tx, &state, user_id, &scope).await;
            }
            Message::Binary(_) => {}
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(_) => return,
        }
    }
}

async fn handle_text(
    text: &str,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
    scope: &Arc<ConnectionScope>,
) {
    let cmd = match serde_json::from_str::<PromptGenClientCommand>(text) {
        Ok(c) => c,
        Err(_) => return,
    };
    match cmd {
        PromptGenClientCommand::Ping => {
            let _ = tx.send(ServerEvent::Pong);
        }
        PromptGenClientCommand::ListCapabilities { req_id } => {
            promptgen::list_capabilities_ws(req_id, tx, state).await;
        }
        PromptGenClientCommand::GeneratePrompt {
            req_id,
            mode,
            capability,
            query,
            prompt,
        } => {
            // Don't block the reader on OffloadMQ submit — the client may close
            // while we're waiting; connection scope cancels tracked tasks on drop.
            let tx = tx.clone();
            let state = state.clone();
            let scope = scope.clone();
            tokio::spawn(async move {
                promptgen::generate_prompt_ws(
                    req_id, mode, capability, query, prompt, &tx, &state, user_id, &scope,
                )
                .await;
            });
        }
    }
}
