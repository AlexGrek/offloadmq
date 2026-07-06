pub mod service;

use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    extract::{
        Multipart, Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{StatusCode, header},
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
    models::{Agent, CommunicationMethod},
    schema::{self, TaskId},
    state::AppState,
};

pub async fn agent_ping(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    service::do_agent_ping(agent, &state, CommunicationMethod::Http).await?;
    Ok(Json(json!({"status": "ok"})))
}

pub async fn fetch_task_urgent_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let task = service::poll_urgent(agent, &app_state, CommunicationMethod::Http).await?;
    Ok(Json(task))
}

pub async fn fetch_task_non_urgent_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let task = service::poll_non_urgent(agent, &app_state, CommunicationMethod::Http).await?;
    Ok(Json(task))
}

pub async fn update_agent_info(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(state): State<Arc<AppState>>,
    Json(info): Json<schema::AgentUpdateRequest>,
) -> Result<impl IntoResponse, AppError> {
    let resp =
        service::do_update_agent_info(agent, info, &state, CommunicationMethod::Http).await?;
    Ok(Json(resp))
}

pub async fn register_agent(
    State(state): State<Arc<AppState>>,
    Json(req): Json<schema::AgentRegistrationRequest>,
) -> Result<impl IntoResponse, AppError> {
    let resp = service::do_register_agent(req, &state).await?;
    Ok(Json(resp))
}

pub async fn auth_agent(
    State(state): State<Arc<AppState>>,
    Json(request): Json<schema::AgentLoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    let resp = service::do_auth_agent(request, &state).await?;
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
    let base_name = file
        .original_name
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

/// POST /private/agent/bucket/{bucket_uid}/upload
///
/// Allows an authenticated agent to upload a file into an existing bucket.
/// Used to store task output files. Any valid agent JWT can upload to any
/// bucket; agents only know bucket UIDs from their task's `output_bucket` field.
pub async fn upload_to_bucket(
    AuthenticatedAgent(_agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path(bucket_uid): Path<String>,
    mut multipart: Multipart,
) -> Result<Response, AppError> {
    use sha2::{Digest, Sha256};

    let mut bucket = app_state
        .storage
        .buckets
        .get_bucket(&bucket_uid)?
        .ok_or_else(|| AppError::NotFound(format!("Bucket {} not found", bucket_uid)))?;

    let remaining = app_state.config.storage.bucket_size_bytes - bucket.used_bytes;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }

        let original_name = field
            .file_name()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "output".to_string());

        let data = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?;

        let size = data.len() as u64;
        if size > remaining {
            return Err(AppError::BadRequest(format!(
                "File too large: {} bytes, only {} bytes remaining in bucket",
                size, remaining
            )));
        }

        let file_uid = uuid::Uuid::new_v4().to_string();
        let sha256: String = Sha256::digest(&data)
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();

        app_state
            .storage
            .file_store
            .put(&bucket_uid, &file_uid, data.to_vec())
            .await
            .map_err(AppError::Internal)?;

        let file_meta = crate::db::bucket_storage::FileMeta {
            uid: file_uid.clone(),
            original_name: original_name.clone(),
            size,
            sha256: sha256.clone(),
            uploaded_at: chrono::Utc::now(),
        };
        bucket.files.push(file_meta);
        bucket.used_bytes += size;
        app_state.storage.buckets.save_bucket(&bucket).await?;

        let response = Response::builder()
            .status(StatusCode::CREATED)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(format!(
                r#"{{"file_uid":"{file_uid}","original_name":"{original_name}","size":{size},"sha256":"{sha256}"}}"#
            )))
            .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
        return Ok(response);
    }

    Err(AppError::BadRequest(
        "No 'file' field found in multipart body".to_string(),
    ))
}

/// Request body for `POST /private/agent/logs`.
///
/// `agent_id` / `agent_name` / `machine_fingerprint` are taken from the body so
/// the agent can override (e.g. report its own machine fingerprint even if the
/// server has none on record yet). When fields are omitted, sensible fallbacks
/// from the authenticated agent record are used.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogSubmission {
    pub severity: String,
    pub text: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub machine_fingerprint: Option<String>,
}

/// POST /private/agent/logs
///
/// Accepts a single runtime log entry from the authenticated agent.
/// Timestamp is added server-side. Severity must be one of CRITICAL/ERROR/INFO.
pub async fn submit_agent_log(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Json(body): Json<AgentLogSubmission>,
) -> Result<impl IntoResponse, AppError> {
    let severity = crate::db::agent_log_storage::LogSeverity::parse(&body.severity)
        .ok_or_else(|| AppError::BadRequest(format!("invalid severity: {}", body.severity)))?;

    let agent_id = body.agent_id.unwrap_or_else(|| agent.uid.clone());
    let agent_name = body
        .agent_name
        .or_else(|| agent.display_name.clone())
        .or_else(|| Some(agent.uid_short.clone()));
    let machine_fingerprint = body
        .machine_fingerprint
        .or_else(|| agent.system_info.machine_id.clone());

    let record = app_state
        .storage
        .agent_logs
        .push(
            &agent_id,
            agent_name,
            machine_fingerprint,
            severity,
            body.text,
        )
        .map_err(AppError::Internal)?;
    Ok(Json(record))
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
    service::resolve_task(
        agent,
        task_id,
        report,
        &app_state,
        CommunicationMethod::Http,
    )
    .await?;
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
    service::update_task_progress(
        agent,
        task_id,
        update,
        &app_state,
        CommunicationMethod::Http,
    )
    .await?;
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
    if let Err(e) = app_state
        .storage
        .agents
        .update_agent_last_contact(agent.clone(), CommunicationMethod::WebSocket)
        .await
    {
        warn!(
            "Failed to update agent last contact on WebSocket connect: {}",
            e
        );
    }
    Ok(ws.on_upgrade(move |socket| handle_agent_websocket(socket, agent, app_state)))
}

/// Build a JSON response envelope for a successful WS request.
fn ws_ok(req_id: &str, status: u16, data: serde_json::Value) -> String {
    json!({
        "req_id": req_id,
        "type": "response",
        "status": status,
        "data": data,
    })
    .to_string()
}

/// Build a JSON error envelope for a failed WS request.
fn ws_err(req_id: &str, err: &AppError) -> String {
    json!({
        "req_id": req_id,
        "type": "error",
        "status": err.status_code_number(),
        "error": {
            "type": err.error_type(),
            "message": err.to_string(),
        },
    })
    .to_string()
}

/// Dispatch a single WS action to the appropriate service function.
///
/// For `upload_file`, the caller must supply the binary payload in `upload_data`.
async fn ws_dispatch(
    action: &str,
    params: &serde_json::Value,
    agent: &Agent,
    state: &Arc<AppState>,
    upload_data: Option<Vec<u8>>,
) -> Result<(u16, serde_json::Value), AppError> {
    match action {
        // ── Heartbeat ────────────────────────────────────────────
        // Agent→server liveness beat (random 60–90s cadence). Bumps the agent's
        // last_contact so it stays online even while idle or busy with a job.
        "heartbeat" | "ping" => {
            service::do_agent_ping(agent.clone(), state, CommunicationMethod::WebSocket).await?;
            Ok((200, json!({"status": "ok"})))
        }

        // ── Poll ─────────────────────────────────────────────────
        "poll_task" => {
            let task =
                service::poll_non_urgent(agent.clone(), state, CommunicationMethod::WebSocket)
                    .await?;
            Ok((200, serde_json::to_value(task).unwrap_or(json!(null))))
        }

        "poll_task_urgent" => {
            let task =
                service::poll_urgent(agent.clone(), state, CommunicationMethod::WebSocket).await?;
            Ok((200, serde_json::to_value(task).unwrap_or(json!(null))))
        }

        // ── Take ─────────────────────────────────────────────────
        "take_task" => {
            let id = params["id"]
                .as_str()
                .ok_or_else(|| AppError::BadRequest("missing params.id".into()))?
                .to_string();
            let cap = params["cap"]
                .as_str()
                .ok_or_else(|| AppError::BadRequest("missing params.cap".into()))?
                .to_string();
            let task_id = TaskId { cap, id };
            let task = service::take_task(agent, task_id, state).await?;
            Ok((200, serde_json::to_value(task).unwrap_or(json!(null))))
        }

        // ── Resolve ──────────────────────────────────────────────
        "resolve_task" => {
            let report: schema::TaskResultReport = serde_json::from_value(params.clone())
                .map_err(|e| AppError::BadRequest(format!("invalid resolve_task params: {e}")))?;
            let task_id = report.id.clone();
            service::resolve_task(
                agent.clone(),
                task_id,
                report,
                state,
                CommunicationMethod::WebSocket,
            )
            .await?;
            Ok((200, json!({"message": "task report confirmed"})))
        }

        // ── Progress ─────────────────────────────────────────────
        "update_progress" => {
            let update: schema::TaskUpdate =
                serde_json::from_value(params.clone()).map_err(|e| {
                    AppError::BadRequest(format!("invalid update_progress params: {e}"))
                })?;
            let task_id = update.id.clone();
            service::update_task_progress(
                agent.clone(),
                task_id,
                update,
                state,
                CommunicationMethod::WebSocket,
            )
            .await?;
            Ok((200, json!({"message": "task update confirmed"})))
        }

        // ── Upload file ──────────────────────────────────────────
        "upload_file" => {
            use sha2::{Digest, Sha256};

            let bucket_uid = params["bucket_uid"]
                .as_str()
                .ok_or_else(|| AppError::BadRequest("missing params.bucket_uid".into()))?;
            let filename = params["filename"].as_str().unwrap_or("output").to_string();
            let data = upload_data.ok_or_else(|| {
                AppError::BadRequest("missing binary frame after upload_file".into())
            })?;

            let mut bucket = state
                .storage
                .buckets
                .get_bucket(bucket_uid)?
                .ok_or_else(|| AppError::NotFound(format!("Bucket {} not found", bucket_uid)))?;

            let remaining = state.config.storage.bucket_size_bytes - bucket.used_bytes;
            let size = data.len() as u64;
            if size > remaining {
                return Err(AppError::BadRequest(format!(
                    "File too large: {} bytes, only {} bytes remaining in bucket",
                    size, remaining
                )));
            }

            let file_uid = uuid::Uuid::new_v4().to_string();
            let sha256: String = Sha256::digest(&data)
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect();

            state
                .storage
                .file_store
                .put(bucket_uid, &file_uid, data)
                .await
                .map_err(AppError::Internal)?;

            let file_meta = crate::db::bucket_storage::FileMeta {
                uid: file_uid.clone(),
                original_name: filename.clone(),
                size,
                sha256: sha256.clone(),
                uploaded_at: chrono::Utc::now(),
            };
            bucket.files.push(file_meta);
            bucket.used_bytes += size;
            state.storage.buckets.save_bucket(&bucket).await?;

            Ok((
                201,
                json!({
                    "file_uid": file_uid,
                    "original_name": filename,
                    "size": size,
                    "sha256": sha256,
                }),
            ))
        }

        // ── Generic GET ──────────────────────────────────────────
        "get" => {
            let path: Vec<String> = params["path"]
                .as_array()
                .ok_or_else(|| AppError::BadRequest("missing params.path array".into()))?
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            ws_route_get(&path, agent, state).await
        }

        // ── Generic POST ─────────────────────────────────────────
        "post" => {
            let path: Vec<String> = params["path"]
                .as_array()
                .ok_or_else(|| AppError::BadRequest("missing params.path array".into()))?
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect();
            let body = params.get("body").cloned().unwrap_or(json!({}));
            ws_route_post(&path, body, agent, state).await
        }

        _ => Err(AppError::BadRequest(format!("unknown action: {action}"))),
    }
}

/// Route generic GET requests by path segments to the appropriate service function.
async fn ws_route_get(
    path: &[String],
    _agent: &Agent,
    state: &Arc<AppState>,
) -> Result<(u16, serde_json::Value), AppError> {
    let segs: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
    match segs.as_slice() {
        // /private/agent/bucket/{uid}/stat
        ["private", "agent", "bucket", uid, "stat"] => {
            let resp = service::get_bucket_stat(uid, state)?;
            Ok((200, serde_json::to_value(resp).unwrap_or(json!(null))))
        }
        // /private/agent/bucket/{uid}/file/{file_uid}
        ["private", "agent", "bucket", uid, "file", file_uid] => {
            let file = service::get_bucket_file(uid, file_uid, state).await?;
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&file.data);
            Ok((
                200,
                json!({
                    "content": b64,
                    "original_name": file.original_name,
                    "encoding": "base64",
                }),
            ))
        }
        // /private/agent/ping
        ["private", "agent", "ping"] => {
            service::do_agent_ping(_agent.clone(), state, CommunicationMethod::WebSocket).await?;
            Ok((200, json!({"status": "ok"})))
        }
        // /private/agent/task/poll (alias for poll_task)
        ["private", "agent", "task", "poll"] => {
            let task =
                service::poll_non_urgent(_agent.clone(), state, CommunicationMethod::WebSocket)
                    .await?;
            Ok((200, serde_json::to_value(task).unwrap_or(json!(null))))
        }
        _ => Err(AppError::NotFound(format!(
            "unknown GET path: {}",
            path.join("/")
        ))),
    }
}

/// Route generic POST requests by path segments to the appropriate service function.
async fn ws_route_post(
    path: &[String],
    body: serde_json::Value,
    agent: &Agent,
    state: &Arc<AppState>,
) -> Result<(u16, serde_json::Value), AppError> {
    let segs: Vec<&str> = path.iter().map(|s| s.as_str()).collect();
    match segs.as_slice() {
        // /private/agent/info/update
        ["private", "agent", "info", "update"] => {
            let req: schema::AgentUpdateRequest = serde_json::from_value(body)
                .map_err(|e| AppError::BadRequest(format!("invalid AgentUpdateRequest: {e}")))?;
            let resp = service::do_update_agent_info(
                agent.clone(),
                req,
                state,
                CommunicationMethod::WebSocket,
            )
            .await?;
            Ok((200, serde_json::to_value(resp).unwrap_or(json!(null))))
        }
        _ => Err(AppError::NotFound(format!(
            "unknown POST path: {}",
            path.join("/")
        ))),
    }
}

async fn handle_agent_websocket(socket: WebSocket, agent: Agent, app_state: Arc<AppState>) {
    use crate::mq::registry::{WS_OUT_CHANNEL_CAPACITY, WsOut};

    let (mut sink, mut receiver) = socket.split();
    let uid = agent.uid.clone();
    let agent_id = agent.uid_short.clone();

    // Single outbound channel. The writer task spawned below is the SOLE owner of
    // the socket sink — responses, the heartbeat, and dispatcher/cancel pushes all
    // funnel through this channel, giving deterministic frame ordering and letting
    // code elsewhere push to this agent via the registry.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<WsOut>(WS_OUT_CHANNEL_CAPACITY);

    // Register BEFORE spawning the writer so a task submission racing the connect
    // can already find this connection and push to it.
    let (conn_id, assigned_set) = app_state.registry.register(&uid, out_tx.clone());

    // Writer task: owns the sink, forwards queued WsOut messages, and emits the
    // heartbeat. Exactly one task ever writes to the socket. The heartbeat fires
    // on a fresh random delay in [min, max] each time (default 60–90s) so a fleet
    // of agents doesn't beat in lockstep.
    let writer_agent_id = agent_id.clone();
    let hb_min = app_state.config.agent_ws.heartbeat_min_secs;
    let hb_max = app_state.config.agent_ws.heartbeat_max_secs;
    let writer_task = tokio::spawn(async move {
        let next_hb_delay = || {
            let secs = if hb_min >= hb_max {
                hb_min
            } else {
                use rand::Rng;
                rand::rng().random_range(hb_min..=hb_max)
            };
            tokio::time::Duration::from_secs(secs)
        };
        let mut hb = Box::pin(tokio::time::sleep(next_hb_delay()));
        let mut counter: u64 = 0;
        loop {
            tokio::select! {
                msg = out_rx.recv() => match msg {
                    Some(WsOut::Text(t)) => {
                        if sink.send(Message::Text(t.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(WsOut::Binary(b)) => {
                        if sink.send(Message::Binary(b.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(WsOut::Close) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                },
                _ = &mut hb => {
                    counter += 1;
                    let msg = json!({
                        "type": "heartbeat",
                        "counter": counter,
                        "timestamp": Utc::now().to_rfc3339()
                    });
                    if sink.send(Message::Text(msg.to_string().into())).await.is_err() {
                        warn!("Failed to send heartbeat to agent {}", writer_agent_id);
                        break;
                    }
                    hb.as_mut().set(tokio::time::sleep(next_hb_delay()));
                }
            }
        }
    });

    // Keepalive: while the socket is open the agent counts as online even if it
    // is idle (sends no requests). Re-fetch the record fresh each tick so we bump
    // `last_contact` without clobbering capability/tier changes from info/update.
    let ka_state = Arc::clone(&app_state);
    let ka_uid = uid.clone();
    let keepalive_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60));
        interval.tick().await; // skip the immediate tick — connect already bumped it
        loop {
            interval.tick().await;
            let Some(fresh) = ka_state.storage.get_agent(&ka_uid) else {
                break;
            };
            if let Err(e) = ka_state
                .storage
                .agents
                .update_agent_last_contact(fresh, CommunicationMethod::WebSocket)
                .await
            {
                warn!("WS keepalive: failed to update last_contact for {ka_uid}: {e}");
            }
        }
    });

    // Welcome message (via the writer channel).
    let welcome = json!({
        "type": "connected",
        "agent_id": agent_id,
        "message": "WebSocket connection established"
    });
    let _ = out_tx.send(WsOut::Text(welcome.to_string())).await;
    info!("Agent {} WebSocket ready (conn {})", agent_id, conn_id);

    // Drain any already-queued work to this agent now that it is connected.
    crate::mq::dispatch::dispatch_to_agent(&app_state, &uid).await;

    // Main receive loop — dispatch requests, send responses via the writer channel.
    while let Some(result) = receiver.next().await {
        match result {
            Ok(Message::Text(text)) => {
                debug!("Received from agent {}: {}", agent_id, text);
                let parsed: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(e) => {
                        warn!("Invalid JSON from agent {}: {}", agent_id, e);
                        continue;
                    }
                };

                let req_id = parsed["req_id"].as_str().unwrap_or("").to_string();
                let action = parsed["action"].as_str().unwrap_or("").to_string();
                let params = parsed.get("params").cloned().unwrap_or(json!({}));

                if action.is_empty() {
                    continue;
                }

                // For upload_file, read the next binary frame from the socket. This
                // read stays in the receive loop; only writes moved to the channel.
                let upload_data = if action == "upload_file" {
                    match receiver.next().await {
                        Some(Ok(Message::Binary(data))) => Some(data.to_vec()),
                        Some(Ok(other)) => {
                            warn!(
                                "Expected binary frame for upload_file from agent {}, got {:?}",
                                agent_id, other
                            );
                            let err_msg = ws_err(
                                &req_id,
                                &AppError::BadRequest(
                                    "expected binary frame after upload_file".into(),
                                ),
                            );
                            let _ = out_tx.send(WsOut::Text(err_msg)).await;
                            continue;
                        }
                        _ => {
                            warn!(
                                "Connection closed while waiting for upload binary from agent {}",
                                agent_id
                            );
                            break;
                        }
                    }
                } else {
                    None
                };

                // Re-fetch the agent record fresh from storage on every dispatched
                // action instead of reusing the connect-time `agent` clone. Without
                // this, a rescanned capability list sent via `info/update` would be
                // clobbered by the very next heartbeat/poll writing the stale
                // snapshot back through `update_agent_last_contact` (which persists
                // the whole agent object) — silently reverting new capabilities
                // until the agent reconnects.
                let current_agent = app_state.storage.get_agent(&uid).unwrap_or_else(|| agent.clone());

                let response_text =
                    match ws_dispatch(&action, &params, &current_agent, &app_state, upload_data)
                        .await
                    {
                        Ok((status, data)) => ws_ok(&req_id, status, data),
                        Err(e) => {
                            if e.should_log() {
                                warn!(
                                    "WS dispatch error for agent {} action {}: {}",
                                    agent_id, action, e
                                );
                            }
                            ws_err(&req_id, &e)
                        }
                    };

                if out_tx.send(WsOut::Text(response_text)).await.is_err() {
                    warn!("Failed to enqueue response to agent {}", agent_id);
                    break;
                }
            }
            Ok(Message::Close(_)) => {
                info!("Agent {} closed WebSocket connection", agent_id);
                break;
            }
            Ok(Message::Ping(_)) => {
                debug!("Received ping from agent {}", agent_id);
            }
            Ok(_) => {}
            Err(e) => {
                warn!("WebSocket error for agent {}: {}", agent_id, e);
                break;
            }
        }
    }

    // Teardown: deregister this connection (conn_id-guarded so a reconnect that
    // already replaced us is left intact), then close the writer.
    app_state.registry.deregister(&uid, conn_id);

    // Re-queue tasks this connection held but the agent never started. Started
    // tasks (Starting/Running) stay assigned — the agent finishes them across
    // reconnects, with orphan recovery as the backstop.
    let held: Vec<TaskId> = {
        let mut guard = assigned_set.lock().unwrap();
        guard.drain().collect()
    };
    if !held.is_empty() {
        crate::mq::dispatch::requeue_disconnected(&app_state, held).await;
    }

    let _ = out_tx.send(WsOut::Close).await;
    writer_task.abort();
    keepalive_task.abort();
    info!(
        "Agent {} WebSocket connection closed (conn {})",
        agent_id, conn_id
    );
}
