//! WebSocket transport for the video prompt generator: connection upgrade, ping/idle
//! management, frame decoding, and command dispatch. Domain logic lives in
//! `services::promptgen`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures::StreamExt;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::time::interval;

use crate::middleware::AuthenticatedUser;
use crate::services::promptgen;
use crate::state::AppState;
use crate::ws::events::{PromptGenClientCommand, ServerEvent};

const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Prevents an urgent blocking result from being sent after the WS disconnects.
pub struct ConnectionScope {
    open: AtomicBool,
}

impl ConnectionScope {
    fn new() -> Self {
        Self {
            open: AtomicBool::new(true),
        }
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    fn close(&self) {
        self.open.store(false, Ordering::SeqCst);
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
    let reader = tokio::spawn(reader_loop(
        stream,
        tx,
        state.clone(),
        user_id,
        scope.clone(),
    ));
    let writer_abort = writer.abort_handle();
    let reader_abort = reader.abort_handle();

    tokio::select! {
        _ = writer => { reader_abort.abort(); }
        _ = reader => { writer_abort.abort(); }
    }

    scope.close();
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
        PromptGenClientCommand::GenerateVideoPrompt {
            req_id,
            capability,
            image_id,
        } => {
            tracing::debug!(
                user_id, req_id = %req_id, capability = %capability, image_id = %image_id,
                "ws: generate_video_prompt received"
            );
            // Keep the WS reader responsive during the urgent blocking request.
            // Upstream deadlines bound inference; the service releases its frame bucket.
            let tx = tx.clone();
            let state = state.clone();
            let scope = scope.clone();
            tokio::spawn(async move {
                promptgen::generate_video_prompt_ws(
                    req_id, capability, image_id, &tx, &state, user_id, &scope,
                )
                .await;
            });
        }
    }
}
