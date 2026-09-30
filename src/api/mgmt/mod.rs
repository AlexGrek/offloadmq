pub mod heuristics;
pub mod k8s;
pub mod storage;

use std::{collections::HashSet, env, sync::Arc};

use axum::{
    Json,
    extract::{
        Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::{
        IntoResponse,
        sse::{Event, Sse},
    },
};
use serde::Deserialize;
use serde_json::json;
use std::convert::Infallible;
use tracing::info;

use crate::{
    db::persistent_task_storage::AssignedStatusFilter,
    error::AppError,
    models::{Agent, ClientApiKey},
    schema::{self},
    state::{AppState, StreamEvent},
    utils::base_capability,
};

/// Serialize an agent for the management UI and attach live runtime state that
/// isn't part of the persisted record: `inFlight` (non-terminal tasks the agent
/// currently holds, the authoritative busy count) and `connected` (live WS).
fn agent_with_runtime(state: &Arc<AppState>, agent: &Agent) -> serde_json::Value {
    let mut value = serde_json::to_value(agent).unwrap_or_else(|_| json!({}));
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "inFlight".to_string(),
            json!(state.agent_load.in_flight(&agent.uid)),
        );
        obj.insert(
            "connected".to_string(),
            json!(state.registry.is_connected(&agent.uid)),
        );
    }
    value
}

pub async fn list_agents(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let agents: Vec<serde_json::Value> = state
        .storage
        .agents
        .list_all_agents()
        .iter()
        .map(|a| agent_with_runtime(&state, a))
        .collect();
    Ok(Json(agents))
}

pub async fn list_agents_online(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let agents: Vec<serde_json::Value> = state
        .storage
        .agents
        .list_all_agents()
        .into_iter()
        .filter(Agent::is_online)
        .map(|a| agent_with_runtime(&state, &a))
        .collect();
    Ok(Json(agents))
}

pub async fn remove_agent(
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    state.storage.delete_agent(&agent_id).await?;
    Ok(Json(json!("Agent deleted")))
}

pub async fn version() -> impl IntoResponse {
    let v = env::var("APP_VERSION").unwrap_or_else(|_| "unknown".to_string());
    Json(json!({ "version": v }))
}

pub async fn capabilities_online(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let mut capabilities = HashSet::new();
    state
        .storage
        .agents
        .list_all_agents()
        .into_iter()
        .filter(Agent::is_online)
        .flat_map(|agent| agent.capabilities)
        .for_each(|cap| {
            capabilities.insert(base_capability(&cap).to_string());
        });
    Ok(Json(capabilities))
}

pub async fn capabilities_online_ext(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let mut capabilities: HashSet<String> = HashSet::new();
    state
        .storage
        .agents
        .list_all_agents()
        .into_iter()
        .filter(Agent::is_online)
        .flat_map(|agent| agent.capabilities)
        .for_each(|cap| {
            capabilities.insert(cap);
        });
    Ok(Json(capabilities))
}

pub async fn client_api_keys(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let keys = state.storage.client_keys.list_all();
    Ok(Json(keys))
}

pub async fn revoke_client_api_key(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let mut key = state
        .storage
        .client_keys
        .find_active(&id)?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;
    key.is_revoked = true;
    state.storage.client_keys.update_key(&id, &key)?;
    Ok(Json(key))
}

pub async fn add_client_api_key(
    State(state): State<Arc<AppState>>,
    Json(new_key): Json<schema::CreateApiKeyRequest>,
) -> Result<impl IntoResponse, AppError> {
    let key: ClientApiKey = new_key.into();
    state.storage.client_keys.upsert_key(&key.key, &key)?;
    Ok(Json(key))
}

/// Default and maximum number of tasks returned per list by `GET /tasks/list`.
const TASK_LIST_DEFAULT_LIMIT: usize = 200;
const TASK_LIST_MAX_LIMIT: usize = 1000;

#[derive(Deserialize, Default)]
pub struct ListTasksQuery {
    /// `active` (not yet finished), `terminal` (finished) or `all` (default).
    pub status: Option<String>,
    /// Max tasks per list (default 200, capped at 1000).
    pub limit: Option<usize>,
    /// RFC 3339 timestamp; drop assigned tasks whose last activity is older.
    pub since: Option<chrono::DateTime<chrono::Utc>>,
}

/// Bounded task listing. Each of the four lists is capped at `limit`; `meta`
/// reports the real totals and whether anything was cut, so callers can tell
/// a short list from a truncated one. Assigned tasks come newest-first.
pub async fn list_tasks(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListTasksQuery>,
) -> Result<impl IntoResponse, AppError> {
    let filter = match params.status.as_deref() {
        None | Some("all") => AssignedStatusFilter::All,
        Some("active") => AssignedStatusFilter::Active,
        Some("terminal") => AssignedStatusFilter::Terminal,
        Some(other) => {
            return Err(AppError::Validation(format!(
                "status must be one of active, terminal, all (got '{other}')"
            )));
        }
    };
    let limit = params
        .limit
        .unwrap_or(TASK_LIST_DEFAULT_LIMIT)
        .min(TASK_LIST_MAX_LIMIT);

    // Queued / in-flight urgent and unassigned tasks are never finished, so
    // they are omitted only when the caller asked for finished tasks alone.
    let include_queued = filter != AssignedStatusFilter::Terminal;

    let (urgent_assigned, urgent_unassigned, urgent_assigned_total, urgent_unassigned_total) =
        if include_queued {
            let tasks = state.urgent.tasks.read().await;
            let assigned: Vec<_> = tasks
                .values()
                .filter_map(|entry| entry.assigned_task.clone())
                .collect();
            let unassigned: Vec<_> = tasks
                .values()
                .filter(|entry| entry.assigned_task.is_none())
                .map(|entry| entry.task.clone())
                .collect();
            let totals = (assigned.len(), unassigned.len());
            (
                assigned.into_iter().take(limit).collect::<Vec<_>>(),
                unassigned.into_iter().take(limit).collect::<Vec<_>>(),
                totals.0,
                totals.1,
            )
        } else {
            (Vec::new(), Vec::new(), 0, 0)
        };

    let since = params.since;
    let blocking_state = state.clone();
    let (regular_assigned, regular_assigned_total) = tokio::task::spawn_blocking(move || {
        blocking_state
            .storage
            .tasks
            .list_assigned_filtered(filter, since, limit)
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("task listing panicked: {e}")))??;

    let (regular_unassigned, regular_unassigned_total) = if include_queued {
        let all = state.regular.list_all().await;
        let total = all.len();
        (all.into_iter().take(limit).collect::<Vec<_>>(), total)
    } else {
        (Vec::new(), 0)
    };

    let truncated = regular_assigned_total > regular_assigned.len()
        || regular_unassigned_total > regular_unassigned.len()
        || urgent_assigned_total > urgent_assigned.len()
        || urgent_unassigned_total > urgent_unassigned.len();

    Ok(Json(json!({
        "urgent": {"assigned": urgent_assigned, "unassigned": urgent_unassigned},
        "regular": {"assigned": regular_assigned, "unassigned": regular_unassigned},
        "meta": {
            "limit": limit,
            "truncated": truncated,
            "totals": {
                "urgent_assigned": urgent_assigned_total,
                "urgent_unassigned": urgent_unassigned_total,
                "regular_assigned": regular_assigned_total,
                "regular_unassigned": regular_unassigned_total,
            },
        },
    })))
}

pub async fn reset_tasks(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    info!("Tasks reset triggered");
    state.storage.tasks.hard_clear()?;
    state.urgent.hard_clear().await;
    state.regular.hard_clear().await;
    Ok(Json(json!({"result": "Reset successful"})))
}

pub async fn cancel_task(
    State(state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let task_id = schema::TaskId::from_url(id, cap)?;
    let resp = crate::api::client::service::do_cancel_task(&state, task_id, "", true).await?;
    Ok(Json(resp))
}

pub async fn reset_agents(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    info!("Agents reset triggered");
    state.storage.agents.clear()?;
    Ok(Json(json!({"result": "Reset successful"})))
}

#[derive(Deserialize)]
pub struct ServiceLogsQuery {
    pub class: String,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

pub async fn list_service_messages(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ServiceLogsQuery>,
) -> Result<impl IntoResponse, AppError> {
    let limit = params.limit.unwrap_or(50).min(500);
    let (items, next_cursor) = state
        .storage
        .service_messages
        .list_by_class(&params.class, limit, params.cursor.as_deref())
        .map_err(AppError::Internal)?;

    Ok(Json(json!({
        "class": params.class,
        "items": items,
        "next_cursor": next_cursor,
        "count": items.len(),
    })))
}

pub async fn stream_service_messages_ws(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    Ok(ws.on_upgrade(move |socket| handle_service_messages_ws(socket, state)))
}

pub async fn stream_task_lifecycle_ws(
    State(state): State<Arc<AppState>>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    Ok(ws.on_upgrade(move |socket| handle_task_lifecycle_ws(socket, state)))
}

pub async fn stream_task_lifecycle_sse(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let rx = state.subscribe_stream();
    let stream = futures::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(StreamEvent::TaskLifecycle(event)) => {
                    if let Ok(payload) = serde_json::to_string(&event) {
                        let ev = Event::default().event("taskLifecycle").data(payload);
                        return Some((Ok::<Event, Infallible>(ev), rx));
                    }
                }
                Ok(StreamEvent::ServiceMessage(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Ok(Sse::new(stream))
}

async fn handle_service_messages_ws(socket: WebSocket, state: Arc<AppState>) {
    use futures::{SinkExt, StreamExt};

    let (mut sender, mut receiver) = socket.split();
    let mut events = state.subscribe_stream();

    loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Ok(StreamEvent::ServiceMessage(msg)) => {
                        if let Ok(payload) = serde_json::to_string(&msg) {
                            if sender.send(Message::Text(payload.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Ok(StreamEvent::TaskLifecycle(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

async fn handle_task_lifecycle_ws(socket: WebSocket, state: Arc<AppState>) {
    use futures::{SinkExt, StreamExt};

    let (mut sender, mut receiver) = socket.split();
    let mut events = state.subscribe_stream();

    loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Ok(StreamEvent::TaskLifecycle(event)) => {
                        if let Ok(payload) = serde_json::to_string(&event) {
                            if sender.send(Message::Text(payload.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Ok(StreamEvent::ServiceMessage(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

pub async fn trigger_heuristics_cleanup(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let ttl_days = state.config.heuristics.ttl_days;
    let max_records = state.config.heuristics.max_records_per_runner_cap;

    let (deleted_by_age, deleted_by_limit) = state
        .storage
        .heuristics
        .cleanup(ttl_days, max_records)
        .map_err(AppError::Internal)?;

    info!(
        "Management: heuristics cleanup triggered, deleted {} by age, {} by limit",
        deleted_by_age, deleted_by_limit
    );
    Ok(Json(json!({
        "deleted_by_age": deleted_by_age,
        "deleted_by_limit": deleted_by_limit,
        "ttl_days": ttl_days,
        "max_records_per_runner_cap": max_records,
    })))
}

#[derive(Deserialize)]
pub struct AgentLogsBySeverityQuery {
    pub severity: String,
    /// Default 100. Pass -1 to return all records.
    pub limit: Option<i64>,
}

pub async fn list_agent_logs_by_severity(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AgentLogsBySeverityQuery>,
) -> Result<impl IntoResponse, AppError> {
    let severity = crate::db::agent_log_storage::LogSeverity::parse(&params.severity)
        .ok_or_else(|| AppError::BadRequest(format!("invalid severity: {}", params.severity)))?;
    let limit = params.limit.unwrap_or(100);
    let items = state
        .storage
        .agent_logs
        .list_by_severity(severity, limit)
        .map_err(AppError::Internal)?;
    Ok(Json(json!({
        "severity": severity.as_str(),
        "count": items.len(),
        "items": items,
    })))
}

#[derive(Deserialize)]
pub struct AgentLogsByAgentQuery {
    pub agent_id: String,
    pub limit: Option<i64>,
}

pub async fn list_agent_logs_by_agent(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AgentLogsByAgentQuery>,
) -> Result<impl IntoResponse, AppError> {
    let limit = params.limit.unwrap_or(100);
    let items = state
        .storage
        .agent_logs
        .list_by_agent(&params.agent_id, limit)
        .map_err(AppError::Internal)?;
    Ok(Json(json!({
        "agentId": params.agent_id,
        "count": items.len(),
        "items": items,
    })))
}

#[derive(Deserialize)]
pub struct AgentLogsLatestQuery {
    pub limit: Option<i64>,
}

pub async fn list_agent_logs_latest(
    State(state): State<Arc<AppState>>,
    Query(params): Query<AgentLogsLatestQuery>,
) -> Result<impl IntoResponse, AppError> {
    let limit = params.limit.unwrap_or(100);
    let items = state
        .storage
        .agent_logs
        .list_latest(limit)
        .map_err(AppError::Internal)?;
    Ok(Json(json!({
        "count": items.len(),
        "items": items,
    })))
}

pub async fn trigger_agent_logs_cleanup(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let deleted = state
        .storage
        .agent_logs
        .cleanup_older_than(14)
        .map_err(AppError::Internal)?;
    info!(
        "Management: agent_logs cleanup triggered, deleted {} record(s)",
        deleted
    );
    Ok(Json(json!({"deleted": deleted, "max_age_days": 14})))
}

pub async fn trigger_stale_agents_cleanup(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let ttl_days = state.config.stale_agents.ttl_days;

    let deleted = state.storage.agents.cleanup_stale_agents(ttl_days).await?;

    info!(
        "Management: stale agents cleanup triggered, deleted {} agent(s)",
        deleted
    );
    Ok(Json(json!({
        "deleted": deleted,
        "ttl_days": ttl_days,
    })))
}
