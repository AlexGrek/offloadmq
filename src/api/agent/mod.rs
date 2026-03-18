pub mod service;

use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State, WebSocketUpgrade, ws::{Message, WebSocket}},
    http::header,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use futures::{SinkExt, StreamExt};
use log::{debug, info, warn};
use serde::Deserialize;
use serde_json::json;

use crate::{
    error::AppError,
    middleware::AuthenticatedAgent,
    schema::{self, TaskId},
    state::AppState,
};

pub async fn fetch_task_urgent_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let task = service::poll_urgent(agent, &app_state).await?;
    Ok(Json(task))
}

pub async fn fetch_task_non_urgent_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let task = service::poll_non_urgent(agent, &app_state).await?;
    Ok(Json(task))
}

pub async fn update_agent_info(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(state): State<Arc<AppState>>,
    Json(info): Json<schema::AgentUpdateRequest>,
) -> Result<impl IntoResponse, AppError> {
    let resp = service::do_update_agent_info(agent, info, &state)?;
    Ok(Json(resp))
}

pub async fn register_agent(
    State(state): State<Arc<AppState>>,
    Json(req): Json<schema::AgentRegistrationRequest>,
) -> Result<impl IntoResponse, AppError> {
    let resp = service::do_register_agent(req, &state)?;
    Ok(Json(resp))
}

pub async fn auth_agent(
    State(state): State<Arc<AppState>>,
    Json(request): Json<schema::AgentLoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    let resp = service::do_auth_agent(request, &state)?;
    Ok(Json(resp))
}

/// GET /private/agent/bucket/{bucket_uid}/stat
///
/// Returns the list of files in a bucket so the agent can discover file UIDs
/// for downloading.  Same security model as `download_bucket_file`: any valid
/// agent JWT can access any bucket; unguessable UUIDs act as capability tokens.
pub async fn bucket_stat(
    AuthenticatedAgent(_agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path(bucket_uid): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let resp = service::get_bucket_stat(&bucket_uid, &app_state)?;
    Ok(Json(resp))
}

/// GET /private/agent/bucket/{bucket_uid}/file/{file_uid}
///
/// Allows an authenticated agent to download a file from a storage bucket.
/// Any valid agent JWT can access any bucket; the unguessable UUIDs act as
/// capability tokens and agents only learn them from task `file_bucket` fields.
pub async fn download_bucket_file(
    AuthenticatedAgent(_agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((bucket_uid, file_uid)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let file = service::get_bucket_file(&bucket_uid, &file_uid, &app_state).await?;

    // Use only the base filename in Content-Disposition (RFC 6266 — path
    // separators don't belong in the filename parameter).  Agents use the
    // original_name from the bucket stat response to reconstruct the full path.
    let base_name = file.original_name
        .rsplit('/')
        .next()
        .unwrap_or(&file.original_name);
    let disposition = format!(
        "attachment; filename=\"{}\"",
        base_name.replace('"', "\\\"")
    );
    let response = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CONTENT_LENGTH, file.data.len())
        .body(Body::from(file.data))
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    Ok(response)
}

pub async fn try_take_task_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let task_id = TaskId::from_url(id, cap)?;
    let task = service::take_task(&agent, task_id, &app_state).await?;
    Ok(Json(task))
}

pub async fn post_task_resolution(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
    Json(report): Json<schema::TaskResultReport>,
) -> Result<impl IntoResponse, AppError> {
    let task_id = TaskId::from_url(id.clone(), cap)?;
    if report.id != task_id {
        return Err(AppError::BadRequest(id));
    }
    service::resolve_task(agent, task_id, report, &app_state).await?;
    Ok(Json(json!({"message": "task report confirmed"})))
}

pub async fn post_task_progress_update(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
    Json(update): Json<schema::TaskUpdate>,
) -> Result<impl IntoResponse, AppError> {
    let task_id = TaskId::from_url(id.clone(), cap)?;
    if update.id != task_id {
        return Err(AppError::BadRequest(id));
    }
    service::update_task_progress(agent, task_id, update, &app_state).await?;
    Ok(Json(json!({"message": "task update confirmed"})))
}

#[derive(Debug, Deserialize)]
pub struct WsAuthQuery {
    pub token: String,
}

pub async fn websocket_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsAuthQuery>,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let claims = app_state
        .auth
        .decode_token(&query.token)
        .map_err(|_| AppError::Authorization("Invalid or expired token".to_string()))?;
    let agent = app_state
        .storage
        .get_agent(&claims.sub)
        .ok_or_else(|| AppError::Authorization("Agent not found".to_string()))?;
    info!("Agent {} connected via WebSocket", agent.uid_short);
    Ok(ws.on_upgrade(move |socket| handle_agent_websocket(socket, agent.uid_short)))
}

async fn handle_agent_websocket(socket: WebSocket, agent_id: String) {
    let (mut sender, mut receiver) = socket.split();

    let welcome = json!({
        "type": "connected",
        "agent_id": agent_id,
        "message": "WebSocket connection established"
    });
    if sender
        .send(Message::Text(welcome.to_string().into()))
        .await
        .is_err()
    {
        warn!("Failed to send welcome message to agent {}", agent_id);
        return;
    }

    let agent_id_clone = agent_id.clone();
    let send_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
        let mut counter: u64 = 0;
        loop {
            interval.tick().await;
            counter += 1;
            let msg = json!({
                "type": "heartbeat",
                "counter": counter,
                "timestamp": Utc::now().to_rfc3339()
            });
            if sender
                .send(Message::Text(msg.to_string().into()))
                .await
                .is_err()
            {
                warn!("Failed to send heartbeat to agent {}", agent_id_clone);
                break;
            }
            debug!("Sent heartbeat {} to agent {}", counter, agent_id_clone);
        }
    });

    while let Some(result) = receiver.next().await {
        match result {
            Ok(Message::Text(text)) => {
                debug!("Received from agent {}: {}", agent_id, text);
            }
            Ok(Message::Close(_)) => {
                info!("Agent {} closed WebSocket connection", agent_id);
                break;
            }
            Ok(Message::Ping(data)) => {
                debug!("Received ping from agent {}", agent_id);
                let _ = data;
            }
            Ok(_) => {}
            Err(e) => {
                warn!("WebSocket error for agent {}: {}", agent_id, e);
                break;
            }
        }
    }

    send_task.abort();
    info!("Agent {} WebSocket connection closed", agent_id);
}
