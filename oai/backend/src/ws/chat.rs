use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures::StreamExt;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::time::interval;

use crate::db::{app_settings, chats as db_chats};
use crate::error::AppError;
use crate::middleware::AuthenticatedUser;
use crate::offload::{ChatMessage, OffloadClient, TaskId};
use crate::state::AppState;
use crate::ws::events::{ClientCommand, ServerEvent};

const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_POLLS: u32 = 300; // 300 × 2s = 10 min hard deadline

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
            handle_list_capabilities(req_id, tx, state).await;
        }
        ClientCommand::Chat { req_id, capability, chat_id, content } => {
            handle_chat(req_id, capability, chat_id, content, tx, state, user_id).await;
        }
    }
}

async fn make_offload_client(state: &AppState) -> Result<OffloadClient, AppError> {
    let settings = app_settings::get(&state.db).await?;
    let api_key = settings.client_api_token.unwrap_or_default();
    Ok(OffloadClient::new(state.http.clone(), settings.offloadmq_url, api_key))
}

async fn handle_list_capabilities(
    req_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
) {
    let client = match make_offload_client(state).await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(ServerEvent::Error { req_id: Some(req_id), message: e.to_string() });
            return;
        }
    };
    match client.list_llm_capabilities().await {
        Ok(caps) => {
            let _ = tx.send(ServerEvent::Capabilities { req_id, capabilities: caps });
        }
        Err(e) => {
            let _ = tx.send(ServerEvent::Error { req_id: Some(req_id), message: e.to_string() });
        }
    }
}

async fn handle_chat(
    req_id: String,
    capability: String,
    chat_id_str: String,
    content: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) {
    let chat_id: i64 = match chat_id_str.parse() {
        Ok(v) => v,
        Err(_) => {
            let _ = tx.send(ServerEvent::Error {
                req_id: Some(req_id),
                message: "invalid chat_id".into(),
            });
            return;
        }
    };

    // Verify ownership and load history
    let chat = match db_chats::get_chat(&state.db, chat_id, user_id).await {
        Ok(Some(c)) => c,
        Ok(None) => {
            let _ = tx.send(ServerEvent::Error {
                req_id: Some(req_id),
                message: "chat not found".into(),
            });
            return;
        }
        Err(e) => {
            let _ = tx.send(ServerEvent::Error {
                req_id: Some(req_id),
                message: e.to_string(),
            });
            return;
        }
    };

    let history = match db_chats::get_messages(&state.db, chat_id).await {
        Ok(msgs) => msgs,
        Err(e) => {
            let _ = tx.send(ServerEvent::Error {
                req_id: Some(req_id),
                message: e.to_string(),
            });
            return;
        }
    };

    // Persist user message now
    let user_msg_id = state.next_id();
    if let Err(e) =
        db_chats::add_message(&state.db, user_msg_id, chat_id, "user", &content, "complete", None)
            .await
    {
        let _ =
            tx.send(ServerEvent::Error { req_id: Some(req_id), message: e.to_string() });
        return;
    }

    // Auto-title chat on first message
    if chat.title.is_empty() {
        let title = content.chars().take(50).collect::<String>();
        let _ = db_chats::set_title(&state.db, chat_id, &title).await;
    } else {
        let _ = db_chats::touch_chat(&state.db, chat_id).await;
    }

    // Build Ollama-format messages from history + new user message
    let mut messages: Vec<ChatMessage> = history
        .iter()
        .filter(|m| m.status == "complete")
        .map(|m| ChatMessage { role: m.role.clone(), content: m.content.clone() })
        .collect();
    messages.push(ChatMessage { role: "user".to_string(), content: content.clone() });

    let client = match make_offload_client(state).await {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(ServerEvent::Error { req_id: Some(req_id), message: e.to_string() });
            return;
        }
    };

    match client.submit_chat(&capability, messages).await {
        Ok(task_id) => {
            // Allocate assistant message id now so poll_loop can fill it in
            let assistant_msg_id = state.next_id();
            let _ = tx.send(ServerEvent::TaskQueued {
                req_id: req_id.clone(),
                cap: task_id.cap.clone(),
                id: task_id.id.clone(),
            });
            tokio::spawn(poll_loop(
                req_id,
                task_id,
                client,
                tx.clone(),
                state.clone(),
                chat_id,
                assistant_msg_id,
                capability,
            ));
        }
        Err(e) => {
            let _ = tx.send(ServerEvent::Error { req_id: Some(req_id), message: e.to_string() });
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn poll_loop(
    req_id: String,
    task_id: TaskId,
    client: OffloadClient,
    tx: UnboundedSender<ServerEvent>,
    state: Arc<AppState>,
    chat_id: i64,
    assistant_msg_id: i64,
    capability: String,
) {
    for _ in 0..MAX_POLLS {
        tokio::time::sleep(POLL_INTERVAL).await;

        let resp = match client.poll_task(&task_id).await {
            Ok(r) => r,
            Err(e) => {
                let _ = tx.send(ServerEvent::Error {
                    req_id: Some(req_id),
                    message: e.to_string(),
                });
                return;
            }
        };

        match resp.status.as_str() {
            "completed" => {
                let text = extract_llm_text(&resp.output);
                // Persist assistant message
                let _ = db_chats::add_message(
                    &state.db,
                    assistant_msg_id,
                    chat_id,
                    "assistant",
                    &text,
                    "complete",
                    Some(&capability),
                )
                .await;
                let _ = db_chats::touch_chat(&state.db, chat_id).await;
                let _ = tx.send(ServerEvent::TaskResult {
                    req_id,
                    cap: task_id.cap,
                    id: task_id.id,
                    text,
                    log: resp.log,
                });
                return;
            }
            "failed" => {
                let error = extract_error_text(&resp.output);
                let _ = db_chats::add_message(
                    &state.db,
                    assistant_msg_id,
                    chat_id,
                    "assistant",
                    &error,
                    "failed",
                    Some(&capability),
                )
                .await;
                let _ = tx.send(ServerEvent::TaskFailed {
                    req_id,
                    cap: task_id.cap,
                    id: task_id.id,
                    error,
                    log: resp.log,
                });
                return;
            }
            "canceled" => {
                let _ = db_chats::add_message(
                    &state.db,
                    assistant_msg_id,
                    chat_id,
                    "assistant",
                    "Task was canceled",
                    "failed",
                    Some(&capability),
                )
                .await;
                let _ = tx.send(ServerEvent::TaskFailed {
                    req_id,
                    cap: task_id.cap,
                    id: task_id.id,
                    error: "Task was canceled".to_string(),
                    log: resp.log,
                });
                return;
            }
            status => {
                if tx
                    .send(ServerEvent::TaskProgress {
                        req_id: req_id.clone(),
                        cap: task_id.cap.clone(),
                        id: task_id.id.clone(),
                        status: status.to_string(),
                        stage: resp.stage,
                        log: resp.log,
                    })
                    .is_err()
                {
                    return; // receiver dropped — WS is gone
                }
            }
        }
    }

    // Deadline exceeded
    let _ = db_chats::add_message(
        &state.db,
        assistant_msg_id,
        chat_id,
        "assistant",
        "Task timed out waiting for result",
        "failed",
        Some(&capability),
    )
    .await;
    let _ = tx.send(ServerEvent::TaskFailed {
        req_id,
        cap: task_id.cap,
        id: task_id.id,
        error: "Task timed out waiting for result".to_string(),
        log: None,
    });
}

fn extract_llm_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(|v| v.get("response").and_then(|r| r.as_str()))
        .unwrap_or("")
        .to_string()
}

fn extract_error_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).or_else(|| v.as_str()))
        .unwrap_or("Unknown error")
        .to_string()
}
