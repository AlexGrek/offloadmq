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
use rand::seq::IndexedRandom;
use serde::Deserialize;
use serde_json::json;

use crate::{
    error::AppError,
    middleware::AuthenticatedAgent,
    models::{Agent, UnassignedTask},
    mq::scheduler::{
        find_assignable_non_urgent_tasks_with_capabilities_for_tier,
        find_urgent_tasks_with_capabilities, report_non_urgent_task, report_urgent_task,
        try_pick_up_non_urgent_task, try_pick_up_urgent_task, update_non_urgent_task,
        update_urgent_task,
    },
    schema::{self, TaskId, TaskResultReport, TaskUpdate},
    state::AppState,
};

pub async fn fetch_task_urgent_handler(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    agent = app_state.storage.agents.update_agent_last_contact(agent)?;
    let caps = &agent.capabilities;
    let urgent = find_urgent_tasks_with_capabilities(&app_state.urgent, caps).await;
    Ok(Json(urgent))
}

pub async fn fetch_task_non_urgent_handler(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    agent = app_state.storage.agents.update_agent_last_contact(agent)?;
    let caps = &agent.capabilities;
    debug!(
        "Searching for tasks for agent {:?} with tier {:?}",
        agent, agent.tier
    );
    let urgent = find_urgent_tasks_with_capabilities(&app_state.urgent, caps).await;
    if let Some(urgent_found) = urgent {
        return Ok(Json(urgent_found).into_response());
    }
    let all = find_assignable_non_urgent_tasks_with_capabilities_for_tier(
        &app_state.storage.tasks,
        caps,
        agent.tier,
        &app_state.storage.agents,
    )
    .await?;
    if all.len() > 0 {
        // pick random
        let mut rng = rand::rng();
        let random_item = all.choose(&mut rng).unwrap(); // we already checked length
        Ok(Json(random_item).into_response())
    } else {
        Ok(Json(Option::<UnassignedTask>::None).into_response())
    }
}

pub async fn update_agent_info(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(state): State<Arc<AppState>>,
    Json(info): Json<schema::AgentUpdateRequest>,
) -> Result<impl IntoResponse, AppError> {
    agent.capabilities = info.capabilities;
    agent.capacity = info.capacity;
    agent.last_contact = Some(Utc::now());
    agent.system_info = info.system_info;
    agent.tier = info.tier;

    let uid = agent.uid.clone();
    let key = agent.personal_login_token.clone();

    state.storage.agents.update_agent(agent)?;
    Ok(Json(schema::AgentRegistrationResponse {
        agent_id: uid,
        message: "Updated".to_string(),
        key: key,
    }))
}

pub async fn register_agent(
    State(state): State<Arc<AppState>>,
    Json(agent): Json<schema::AgentRegistrationRequest>,
) -> Result<impl IntoResponse, AppError> {
    validate_api_key(&state.config.agent_api_keys, &agent.api_key)?;
    let mut agent_object: Agent = agent.into();
    state.storage.agents.create_agent(&mut agent_object)?;
    Ok(Json(schema::AgentRegistrationResponse {
        agent_id: agent_object.uid,
        message: "Registered".to_string(),
        key: agent_object.personal_login_token,
    }))
}

pub async fn auth_agent(
    State(state): State<Arc<AppState>>,
    Json(request): Json<schema::AgentLoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    let mk_auth_err = || AppError::Authorization("Incorrect credentials".to_string());
    let agent = state
        .storage
        .agents
        .get_agent(&request.agent_id)
        .ok_or_else(|| mk_auth_err())?;
    if agent.personal_login_token != request.key {
        return Err(mk_auth_err());
    }
    let (token, expires_in) = state.auth.create_token(&agent.uid)?;
    Ok(Json(schema::AgentLoginResponse { token, expires_in }))
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
    let bucket = app_state
        .storage
        .buckets
        .get_bucket(&bucket_uid)?
        .ok_or_else(|| AppError::NotFound(format!("Bucket {} not found", bucket_uid)))?;

    let files: Vec<_> = bucket
        .files
        .iter()
        .map(|f| {
            json!({
                "file_uid":      f.uid,
                "original_name": f.original_name,
                "size":          f.size,
                "sha256":        f.sha256,
            })
        })
        .collect();

    Ok(Json(json!({
        "bucket_uid": bucket.uid,
        "file_count": files.len(),
        "files":      files,
    })))
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
    let bucket = app_state
        .storage
        .buckets
        .get_bucket(&bucket_uid)?
        .ok_or_else(|| AppError::NotFound(format!("Bucket {} not found", bucket_uid)))?;

    let file_meta = bucket
        .files
        .iter()
        .find(|f| f.uid == file_uid)
        .ok_or_else(|| {
            AppError::NotFound(format!("File {} not found in bucket {}", file_uid, bucket_uid))
        })?
        .clone();

    let data = app_state
        .storage
        .file_store
        .get(&bucket_uid, &file_uid)
        .await
        .map_err(AppError::Internal)?;

    // Use only the base filename in Content-Disposition (RFC 6266 — path
    // separators don't belong in the filename parameter).  Agents use the
    // original_name from the bucket stat response to reconstruct the full path.
    let base_name = file_meta.original_name
        .rsplit('/')
        .next()
        .unwrap_or(&file_meta.original_name);
    let disposition = format!(
        "attachment; filename=\"{}\"",
        base_name.replace('"', "\\\"")
    );
    let response = Response::builder()
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CONTENT_LENGTH, data.len())
        .body(Body::from(data))
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    Ok(response)
}

fn validate_api_key(keys: &Vec<String>, key: &str) -> Result<(), AppError> {
    if keys.iter().find(|item| *item == key).is_none() {
        return Err(AppError::Authorization("Incorrect API key".to_string()));
    }
    Ok(())
}

pub async fn try_take_task_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    let task_id = TaskId::from_url(id, cap)?;
    info!("Agent {} picking up task {task_id}", agent.uid_short);
    if let Some(picked) = try_pick_up_urgent_task(&app_state.urgent, &agent, &task_id).await? {
        Ok(Json(picked))
    } else {
        Ok(Json(
            try_pick_up_non_urgent_task(&app_state.storage.tasks, &agent, task_id).await?,
        ))
    }
}

pub async fn post_task_resolution(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
    Json(report): Json<TaskResultReport>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    agent = app_state.storage.agents.update_agent_last_contact(agent)?;
    let task_id = TaskId::from_url(id.clone(), cap)?;
    if report.id != task_id {
        return Err(AppError::BadRequest(id));
    }
    info!("Agent {} reporting task {task_id}", agent.uid_short);
    debug!("Report: {:?}", &report);

    let found = report_urgent_task(&app_state.urgent, report.clone(), task_id).await?;
    if !found {
        report_non_urgent_task(&app_state.storage.tasks, report).await?;
    }
    Ok(Json(json!({"message": "task report confirmed"})))
}

pub async fn post_task_progress_update(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
    Json(report): Json<TaskUpdate>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    agent = app_state.storage.agents.update_agent_last_contact(agent)?;
    let task_id = TaskId::from_url(id.clone(), cap)?;
    if report.id != task_id {
        return Err(AppError::BadRequest(id));
    }
    info!(
        "Agent {} updating task {task_id} with log: {:?}",
        agent.uid_short,
        report.log_update.clone().map(|s| s.len()).unwrap_or(0)
    );
    debug!("Update: {:?}", &report);

    let found = update_urgent_task(&app_state.urgent, report.clone(), task_id).await?;
    if !found {
        update_non_urgent_task(&app_state.storage.tasks, report).await?;
    }
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
    // Validate JWT token from query params
    let claims = app_state
        .auth
        .decode_token(&query.token)
        .map_err(|_| AppError::Authorization("Invalid or expired token".to_string()))?;

    // Get the agent from storage
    let agent = app_state
        .storage
        .get_agent(&claims.sub)
        .ok_or_else(|| AppError::Authorization("Agent not found".to_string()))?;

    info!("Agent {} connected via WebSocket", agent.uid_short);

    Ok(ws.on_upgrade(move |socket| handle_agent_websocket(socket, agent.uid_short)))
}

async fn handle_agent_websocket(socket: WebSocket, agent_id: String) {
    let (mut sender, mut receiver) = socket.split();

    // Send welcome message
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

    // Spawn a task to send periodic dummy messages
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

    // Handle incoming messages from the agent
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
                // Pong is automatically sent by axum
                let _ = data; // suppress unused warning
            }
            Ok(_) => {}
            Err(e) => {
                warn!("WebSocket error for agent {}: {}", agent_id, e);
                break;
            }
        }
    }

    // Abort the send task when connection closes
    send_task.abort();
    info!("Agent {} WebSocket connection closed", agent_id);
}
