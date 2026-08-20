//! `GET /api/task/watch` — a single WebSocket connection over which a client
//! tracks any number of tasks and receives push updates instead of polling
//! `POST /api/task/poll/{cap}/{id}` per task per tick.
//!
//! Design: one connection == one tracked set == one diff cache. Every
//! [`TaskWatchConfig::tick_ms`] the connection re-reads each tracked task via
//! the same [`super::service::do_poll_task_status`] used by the HTTP poll
//! endpoint, diffs it against what was last sent on *this* connection, and —
//! only if something changed — sends one `update` frame covering every task
//! that changed this tick. An idle tracked set produces zero frames.
//!
//! There is no shared broadcast bus for this: the log/output/runtime fields a
//! watcher needs aren't on [`crate::state::StreamEvent`], and per-connection
//! ownership filtering (a client may only watch its own tasks, unless the
//! management override is active) is easiest to apply while reading, not
//! while re-publishing. Tick-and-diff also picks up state changed by the
//! periodic maintenance sweeps in `main.rs` (timeout-fail, orphan-recovery,
//! cancel escalation), none of which emit a `TaskLifecycleEvent`.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    http::HeaderMap,
    response::IntoResponse,
};
use futures::{stream::SplitSink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    middleware::OptionalMgmtOverride,
    models::AssignedTask,
    schema::{TaskId, TaskStatusResponse},
    state::AppState,
};

use super::service::{self, PollOutcome};

const PROTOCOL_VERSION: u32 = 1;

pub async fn task_watch_handler(
    State(state): State<Arc<AppState>>,
    mgmt: OptionalMgmtOverride,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    let skip_owner = mgmt.is_active();
    // `apikey_auth_middleware_user` already validated this header (or the mgmt
    // override) — it just doesn't stash the key anywhere, so re-read it here.
    // The mgmt-override path never needs a real key; ownership checks are
    // skipped entirely when `skip_owner` is true.
    let api_key = headers
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_default();
    if !skip_owner && api_key.is_empty() {
        return Err(AppError::Authorization(
            "Missing X-API-Key header".to_string(),
        ));
    }
    Ok(ws.on_upgrade(move |socket| handle_task_watch(socket, api_key, skip_owner, state)))
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ClientFrame {
    Track { req_id: String, tasks: Vec<TaskId> },
    Untrack { req_id: String, tasks: Vec<TaskId> },
    Sync { req_id: String },
    Ping,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ServerFrame<'a> {
    Hello {
        protocol: u32,
        tick_ms: u64,
        full_sync_secs: u64,
        max_tracked: usize,
    },
    Ack {
        req_id: &'a str,
        tracked: usize,
    },
    Update {
        seq: u64,
        full: bool,
        tasks: Vec<TaskEntry>,
    },
    Error {
        req_id: Option<&'a str>,
        message: String,
        code: &'static str,
    },
    Pong,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskEntry {
    id: TaskId,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    created_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Full log — only present on a full-sync entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    log: Option<String>,
    /// Log bytes appended since the last update sent on this connection —
    /// present on delta entries when the log grew.
    #[serde(skip_serializing_if = "Option::is_none")]
    log_append: Option<String>,
    /// Authoritative total log length, present whenever a log exists, so the
    /// client can detect desync (e.g. after missing a frame).
    #[serde(skip_serializing_if = "Option::is_none")]
    log_len: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    typical_runtime_seconds: Option<f64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    missing: bool,
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

/// A normalized read of a task's current state, independent of which of the
/// four backing stores it came from.
struct TaskState {
    status: String,
    stage: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    log: Option<String>,
    output: Option<serde_json::Value>,
    typical_runtime_seconds: Option<f64>,
}

/// What was last sent to this connection for a tracked task — the diff base.
struct SentState {
    status: String,
    stage: Option<String>,
    log_len: usize,
    output_sent: bool,
    typical_runtime_seconds: Option<f64>,
    missing: bool,
}

async fn handle_task_watch(
    socket: WebSocket,
    api_key: String,
    skip_owner: bool,
    state: Arc<AppState>,
) {
    let (mut sender, mut receiver) = socket.split();
    let cfg = &state.config.task_watch;

    let hello = ServerFrame::Hello {
        protocol: PROTOCOL_VERSION,
        tick_ms: cfg.tick_ms,
        full_sync_secs: cfg.full_sync_secs,
        max_tracked: cfg.max_tracked,
    };
    if send_frame(&mut sender, &hello).await.is_err() {
        return;
    }

    let mut tracked: Vec<TaskId> = Vec::new();
    let mut sent: HashMap<TaskId, SentState> = HashMap::new();
    let mut dirty = false; // force a full sync on the next tick
    let mut seq: u64 = 0;

    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(cfg.tick_ms));
    ticker.tick().await; // discard the immediate first tick
    let mut since_full_sync = std::time::Instant::now();
    let mut shutdown = state.subscribe_shutdown();

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    break;
                }
            }
            _ = ticker.tick() => {
                if tracked.is_empty() {
                    continue;
                }
                let force_full = dirty
                    || since_full_sync.elapsed().as_secs() >= cfg.full_sync_secs;
                let entries = diff_tick(
                    &state, &tracked, &mut sent, &api_key, skip_owner, force_full,
                ).await;
                if entries.is_empty() {
                    continue;
                }
                seq += 1;
                if force_full {
                    since_full_sync = std::time::Instant::now();
                    dirty = false;
                }
                let frame = ServerFrame::Update { seq, full: force_full, tasks: entries };
                if send_frame(&mut sender, &frame).await.is_err() {
                    break;
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if !handle_client_frame(
                            &text, &mut tracked, &mut sent, &mut dirty, &state.config.task_watch,
                            &mut sender,
                        ).await {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

/// Handle one client frame. Returns `false` if the connection should close
/// (send failure).
async fn handle_client_frame(
    text: &str,
    tracked: &mut Vec<TaskId>,
    sent: &mut HashMap<TaskId, SentState>,
    dirty: &mut bool,
    cfg: &crate::config::TaskWatchConfig,
    sender: &mut SplitSink<WebSocket, Message>,
) -> bool {
    let frame: ClientFrame = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(e) => {
            let err = ServerFrame::Error {
                req_id: None,
                message: format!("invalid frame: {e}"),
                code: "bad_request",
            };
            return send_frame(sender, &err).await.is_ok();
        }
    };

    match frame {
        ClientFrame::Ping => send_frame(sender, &ServerFrame::Pong).await.is_ok(),
        ClientFrame::Sync { req_id } => {
            *dirty = true;
            let ack = ServerFrame::Ack {
                req_id: &req_id,
                tracked: tracked.len(),
            };
            send_frame(sender, &ack).await.is_ok()
        }
        ClientFrame::Track { req_id, tasks } => {
            for t in tasks {
                if !tracked.contains(&t) {
                    if tracked.len() >= cfg.max_tracked {
                        let err = ServerFrame::Error {
                            req_id: Some(&req_id),
                            message: format!("tracked-set limit of {} reached", cfg.max_tracked),
                            code: "limit_exceeded",
                        };
                        return send_frame(sender, &err).await.is_ok();
                    }
                    tracked.push(t);
                }
            }
            *dirty = true;
            let ack = ServerFrame::Ack {
                req_id: &req_id,
                tracked: tracked.len(),
            };
            send_frame(sender, &ack).await.is_ok()
        }
        ClientFrame::Untrack { req_id, tasks } => {
            for t in &tasks {
                tracked.retain(|x| x != t);
                sent.remove(t);
            }
            *dirty = true;
            let ack = ServerFrame::Ack {
                req_id: &req_id,
                tracked: tracked.len(),
            };
            send_frame(sender, &ack).await.is_ok()
        }
    }
}

async fn send_frame(
    sender: &mut SplitSink<WebSocket, Message>,
    frame: &ServerFrame<'_>,
) -> Result<(), ()> {
    let Ok(payload) = serde_json::to_string(frame) else {
        return Err(());
    };
    sender.send(Message::Text(payload.into())).await.map_err(|_| ())
}

/// Read every tracked task's current state, diff against `sent`, and return
/// the entries that changed this tick (or, on `force_full`, every tracked
/// task in full).
async fn diff_tick(
    state: &Arc<AppState>,
    tracked: &[TaskId],
    sent: &mut HashMap<TaskId, SentState>,
    api_key: &str,
    skip_owner: bool,
    force_full: bool,
) -> Vec<TaskEntry> {
    let mut out = Vec::new();
    for task_id in tracked {
        let current = read_task_state(state, task_id, api_key, skip_owner).await;
        let prev = sent.get(task_id);

        let Some(current) = current else {
            // Missing: only worth an entry the first time we observe it.
            let already_missing = prev.is_some_and(|p| p.missing);
            if force_full || !already_missing {
                out.push(TaskEntry {
                    id: task_id.clone(),
                    missing: true,
                    ..Default::default()
                });
                sent.insert(
                    task_id.clone(),
                    SentState {
                        status: String::new(),
                        stage: None,
                        log_len: 0,
                        output_sent: false,
                        typical_runtime_seconds: None,
                        missing: true,
                    },
                );
            }
            continue;
        };

        let full_log_len = current.log.as_ref().map(|s| s.len()).unwrap_or(0);

        if force_full || prev.is_none() {
            out.push(TaskEntry {
                id: task_id.clone(),
                status: Some(current.status.clone()),
                stage: current.stage.clone(),
                created_at: Some(current.created_at),
                log: current.log.clone(),
                log_len: current.log.as_ref().map(|_| full_log_len),
                output: current.output.clone(),
                typical_runtime_seconds: current.typical_runtime_seconds,
                missing: false,
                ..Default::default()
            });
            sent.insert(
                task_id.clone(),
                SentState {
                    status: current.status,
                    stage: current.stage,
                    log_len: full_log_len,
                    output_sent: current.output.is_some(),
                    typical_runtime_seconds: current.typical_runtime_seconds,
                    missing: false,
                },
            );
            continue;
        }

        let prev = prev.expect("checked above");
        let status_changed = prev.status != current.status;
        let stage_changed = prev.stage != current.stage;
        let runtime_changed = prev.typical_runtime_seconds != current.typical_runtime_seconds;
        let output_now_present = current.output.is_some() && !prev.output_sent;
        let was_missing = prev.missing;

        // Log delta — the common case is monotonic growth. A shrink or a
        // non-boundary slice means our cached offset is stale; fall back to a
        // full log entry for this task instead of guessing.
        let (log_append, log_full, log_desync) = match (&current.log, prev.log_len) {
            (Some(full), prev_len) if full.len() >= prev_len => {
                if full.len() > prev_len && full.is_char_boundary(prev_len) {
                    (Some(full[prev_len..].to_string()), None, false)
                } else if full.len() > prev_len {
                    (None, Some(full.clone()), true)
                } else {
                    (None, None, false)
                }
            }
            (Some(full), _) => (None, Some(full.clone()), true),
            (None, _) => (None, None, false),
        };

        if !status_changed
            && !stage_changed
            && !runtime_changed
            && !output_now_present
            && !was_missing
            && log_append.is_none()
            && log_full.is_none()
        {
            continue;
        }

        out.push(TaskEntry {
            id: task_id.clone(),
            status: status_changed.then(|| current.status.clone()),
            stage: stage_changed.then(|| current.stage.clone()).flatten(),
            log: log_full,
            log_append,
            log_len: if current.log.is_some() {
                Some(full_log_len)
            } else {
                None
            },
            output: output_now_present.then(|| current.output.clone()).flatten(),
            typical_runtime_seconds: runtime_changed.then_some(current.typical_runtime_seconds).flatten(),
            missing: false,
            ..Default::default()
        });

        sent.insert(
            task_id.clone(),
            SentState {
                status: current.status,
                stage: current.stage,
                log_len: full_log_len,
                output_sent: prev.output_sent || current.output.is_some(),
                typical_runtime_seconds: current.typical_runtime_seconds,
                missing: false,
            },
        );
        let _ = log_desync; // handled implicitly: full entry sent instead of a delta
    }
    out
}

async fn read_task_state(
    state: &Arc<AppState>,
    task_id: &TaskId,
    api_key: &str,
    skip_owner: bool,
) -> Option<TaskState> {
    match service::do_poll_task_status(state, task_id.clone(), api_key, skip_owner).await {
        Ok(PollOutcome::Found(report)) => Some(from_status_response(report)),
        Ok(PollOutcome::FoundUrgent(task)) => {
            // The HTTP urgent branch (`do_poll_task_status`) skips the owner
            // check that the other three stores apply — apply it here so a
            // watch connection cannot observe another key's in-flight urgent
            // task (which would also leak that task's own `data.apiKey`).
            if !skip_owner && task.data.api_key != api_key {
                None
            } else {
                Some(from_assigned(task))
            }
        }
        Err(_) => None,
    }
}

fn from_status_response(r: TaskStatusResponse) -> TaskState {
    TaskState {
        status: status_str(&r.status),
        stage: r.stage,
        created_at: r.created_at,
        log: r.log,
        output: r.output,
        typical_runtime_seconds: r.typical_runtime_seconds.map(|d| d.as_secs_f64()),
    }
}

fn from_assigned(task: AssignedTask) -> TaskState {
    let created_at = task.created_at;
    let report = task.into_status_report();
    TaskState {
        status: status_str(&report.status),
        stage: report.stage,
        created_at,
        log: report.log,
        output: report.output,
        typical_runtime_seconds: report.typical_runtime_seconds.map(|d| d.as_secs_f64()),
    }
}

/// Reuse `TaskStatus`'s own `#[serde(rename_all = "camelCase")]` output
/// (`running`, `cancelRequested`, …) rather than re-deriving the camelCase
/// spelling by hand — the wire protocol must always match the HTTP poll
/// endpoint's status strings.
fn status_str(status: &crate::schema::TaskStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}
