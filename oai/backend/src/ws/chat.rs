//! WebSocket transport for the chat endpoint: connection upgrade, ping/idle
//! management, frame decoding, and command dispatch. All domain logic lives in
//! `services::chat`.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::StreamExt;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::time::interval;

use crate::middleware::AuthenticatedUser;
use crate::services::chat;
use crate::state::AppState;
use crate::ws::events::{ClientCommand, ServerEvent};

const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

pub async fn ws_chat(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Response {
    ws.on_upgrade(move |socket| run_connection(socket, state, user_id))
}

async fn run_connection(socket: WebSocket, state: Arc<AppState>, user_id: i64) {
    let (tx, rx) = unbounded_channel::<ServerEvent>();
    let _ = tx.send(ServerEvent::Hello { user_id });

    let (sink, stream) = socket.split();

    let writer = tokio::spawn(writer_loop(sink, rx));
    let reader = tokio::spawn(reader_loop(stream, tx, state, user_id));
    let writer_abort = writer.abort_handle();
    let reader_abort = reader.abort_handle();

    tokio::select! {
        _ = writer => { reader_abort.abort(); }
        _ = reader => { writer_abort.abort(); }
    }
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
                tracing::debug!("ws idle timeout user={user_id}");
                return;
            }
        };

        let msg = match frame {
            Some(Ok(m)) => m,
            _ => return,
        };
        last_activity = Instant::now();

        match msg {
            Message::Text(text) => handle_text(text.as_str(), &tx, &state, user_id).await,
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
) {
    let cmd = match serde_json::from_str::<ClientCommand>(text) {
        Ok(c) => c,
        Err(_) => return,
    };
    match cmd {
        ClientCommand::Ping => {
            let _ = tx.send(ServerEvent::Pong);
        }
        ClientCommand::ListCapabilities { req_id } => {
            chat::list_capabilities(req_id, tx, state).await;
        }
        ClientCommand::Chat { req_id, capability, chat_id, content, model_online, timeout_secs, max_wait_secs, runtime_secs } => {
            chat::chat(req_id, capability, chat_id, content, model_online, timeout_secs, max_wait_secs, runtime_secs, tx, state, user_id).await;
        }
    }
}
