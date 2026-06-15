//! WebSocket transport for LLM debate: live job updates while turns reconcile.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::StreamExt;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::task::AbortHandle;
use tokio::time::interval;

use crate::middleware::AuthenticatedUser;
use crate::services::llm_debate;
use crate::state::AppState;
use crate::ws::events::{DebateClientCommand, ServerEvent};

const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

struct DebateConnectionScope {
    open: AtomicBool,
    watch: Mutex<Option<AbortHandle>>,
}

impl DebateConnectionScope {
    fn new() -> Self {
        Self {
            open: AtomicBool::new(true),
            watch: Mutex::new(None),
        }
    }

    fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    fn close(&self) {
        self.open.store(false, Ordering::SeqCst);
    }

    fn abort_watch(&self) {
        if let Ok(mut watch) = self.watch.lock() {
            if let Some(handle) = watch.take() {
                handle.abort();
            }
        }
    }

    fn set_watch(&self, handle: AbortHandle) {
        self.abort_watch();
        if let Ok(mut watch) = self.watch.lock() {
            *watch = Some(handle);
        }
    }
}

pub async fn ws_debate(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Response {
    ws.on_upgrade(move |socket| run_connection(socket, state, user_id))
}

async fn run_connection(socket: WebSocket, state: Arc<AppState>, user_id: i64) {
    let scope = Arc::new(DebateConnectionScope::new());
    let (tx, rx) = unbounded_channel::<ServerEvent>();
    let _ = tx.send(ServerEvent::Hello { user_id });

    let (sink, stream) = socket.split();

    let writer = tokio::spawn(writer_loop(sink, rx));
    let reader = tokio::spawn(reader_loop(stream, tx, state, user_id, scope.clone()));
    let writer_abort = writer.abort_handle();
    let reader_abort = reader.abort_handle();

    tokio::select! {
        _ = writer => { reader_abort.abort(); }
        _ = reader => { writer_abort.abort(); }
    }

    scope.close();
    scope.abort_watch();
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
    scope: Arc<DebateConnectionScope>,
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
                tracing::debug!("debate ws idle timeout user={user_id}");
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
    scope: &Arc<DebateConnectionScope>,
) {
    let cmd = match serde_json::from_str::<DebateClientCommand>(text) {
        Ok(c) => c,
        Err(_) => return,
    };
    match cmd {
        DebateClientCommand::Ping => {
            let _ = tx.send(ServerEvent::Pong);
        }
        DebateClientCommand::ListCapabilities { req_id } => {
            llm_debate::list_capabilities_ws(req_id, tx, state).await;
        }
        DebateClientCommand::WatchJob { req_id, job_id } => {
            let tx = tx.clone();
            let state = state.clone();
            let watch_scope = scope.clone();
            let task = tokio::spawn(async move {
                if !watch_scope.is_open() {
                    return;
                }
                llm_debate::watch_job_ws(req_id, job_id, &tx, &state, user_id).await;
            });
            scope.set_watch(task.abort_handle());
        }
    }
}
