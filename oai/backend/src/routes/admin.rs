use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::{app_settings, image_generation, image_worker_logs, users},
    error::AppError,
    middleware::AuthenticatedUser,
    routes::images::{job_details_response, JobDetailsResponse},
    services::{connection, image_jobs, k8s_self},
    state::AppState,
};

#[derive(Deserialize)]
pub struct CheckConnectionRequest {
    pub offloadmq_url: String,
    pub client_api_token: Option<String>,
    pub management_api_token: Option<String>,
}

#[derive(Serialize)]
pub struct TokenCheckResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct CheckConnectionResponse {
    pub client_token: Option<TokenCheckResult>,
    pub management_token: Option<TokenCheckResult>,
}

#[derive(Serialize, Deserialize)]
pub struct SettingsResponse {
    pub offloadmq_url: String,
    pub client_api_token: Option<String>,
    pub management_api_token: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateSettingsRequest {
    pub offloadmq_url: String,
    pub client_api_token: Option<String>,
    pub management_api_token: Option<String>,
}

#[derive(Serialize)]
pub struct AmIAdminResponse {
    pub is_admin: bool,
}

#[derive(Serialize)]
pub struct AdminImageWorkerLog {
    pub id: String,
    pub run_id: String,
    pub level: String,
    pub message: String,
    pub data_json: serde_json::Value,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct AdminImageFileSummary {
    pub id: String,
    pub user_id: String,
    pub job_id: Option<String>,
    pub direction: String,
    pub source: String,
    pub filename: String,
    pub content_type: String,
    pub stored_width: i32,
    pub stored_height: i32,
    pub stored_bytes: i64,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct AdminImageEventSummary {
    pub id: String,
    pub job_id: String,
    pub step: String,
    pub state: String,
    pub details: Option<String>,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct AdminOffloadTaskSummary {
    pub id: String,
    pub job_id: String,
    pub offload_cap: String,
    pub offload_task_id: String,
    pub last_poll_status: Option<String>,
    pub last_poll_stage: Option<String>,
    pub submitted_at: String,
    pub updated_at: String,
}

pub async fn get_settings(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<SettingsResponse>, AppError> {
    let s = app_settings::get(&state.db).await?;
    Ok(Json(SettingsResponse {
        offloadmq_url: s.offloadmq_url,
        client_api_token: s.client_api_token,
        management_api_token: s.management_api_token,
    }))
}

pub async fn update_settings(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Json(req): Json<UpdateSettingsRequest>,
) -> Result<Json<SettingsResponse>, AppError> {
    let s = app_settings::update(
        &state.db,
        req.offloadmq_url,
        req.client_api_token,
        req.management_api_token,
    )
    .await?;
    Ok(Json(SettingsResponse {
        offloadmq_url: s.offloadmq_url,
        client_api_token: s.client_api_token,
        management_api_token: s.management_api_token,
    }))
}

pub async fn am_i_admin(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<AmIAdminResponse>, AppError> {
    let user = users::find_by_id(&state.db, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(AmIAdminResponse { is_admin: user.is_admin == Some(true) }))
}

pub async fn check_connection(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Json(req): Json<CheckConnectionRequest>,
) -> Result<Json<CheckConnectionResponse>, AppError> {
    let client_token = match present_token(&req.client_api_token) {
        Some(token) => Some(into_result(
            connection::probe_client_token(&state.http, &req.offloadmq_url, token).await,
        )),
        None => None,
    };
    let management_token = match present_token(&req.management_api_token) {
        Some(token) => Some(into_result(
            connection::probe_management_token(&state.http, &req.offloadmq_url, token).await,
        )),
        None => None,
    };

    Ok(Json(CheckConnectionResponse { client_token, management_token }))
}

pub async fn admin_list_image_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<Vec<JobDetailsResponse>>, AppError> {
    let details = image_jobs::list_all_job_details(&state, 200).await?;
    Ok(Json(details.into_iter().map(job_details_response).collect()))
}

pub async fn admin_get_image_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Path(job_id): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id)?;
    let detail = image_jobs::any_job_detail(&state, job_id).await?;
    Ok(Json(job_details_response(detail)))
}

pub async fn admin_reconcile_image_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Path(job_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let job_id = parse_id(&job_id)?;
    image_jobs::reconcile_job(&state, job_id).await?;
    Ok(Json(serde_json::json!({ "ok": true, "job_id": job_id.to_string() })))
}

pub async fn admin_list_image_files(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<Vec<AdminImageFileSummary>>, AppError> {
    let files = image_generation::list_image_files_global(&state.db, 500).await?;
    Ok(Json(
        files
            .into_iter()
            .map(|f| AdminImageFileSummary {
                id: f.id.to_string(),
                user_id: f.user_id.to_string(),
                job_id: f.job_id.map(|v| v.to_string()),
                direction: f.direction,
                source: f.source,
                filename: f.filename,
                content_type: f.content_type,
                stored_width: f.stored_width,
                stored_height: f.stored_height,
                stored_bytes: f.stored_bytes,
                created_at: f.created_at.to_rfc3339(),
            })
            .collect(),
    ))
}

pub async fn admin_list_image_events(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<Vec<AdminImageEventSummary>>, AppError> {
    let events = image_generation::list_pipeline_events_global(&state.db, 1000).await?;
    Ok(Json(
        events
            .into_iter()
            .map(|e| AdminImageEventSummary {
                id: e.id.to_string(),
                job_id: e.job_id.to_string(),
                step: e.step,
                state: e.state,
                details: e.details,
                created_at: e.created_at.to_rfc3339(),
            })
            .collect(),
    ))
}

pub async fn admin_list_image_offload_tasks(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<Vec<AdminOffloadTaskSummary>>, AppError> {
    let tasks = image_generation::list_offload_tasks_global(&state.db, 300).await?;
    Ok(Json(
        tasks
            .into_iter()
            .map(|t| AdminOffloadTaskSummary {
                id: t.id.to_string(),
                job_id: t.job_id.to_string(),
                offload_cap: t.offload_cap,
                offload_task_id: t.offload_task_id,
                last_poll_status: t.last_poll_status,
                last_poll_stage: t.last_poll_stage,
                submitted_at: t.submitted_at.to_rfc3339(),
                updated_at: t.updated_at.to_rfc3339(),
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct K8sComponentQuery {
    #[serde(default)]
    pub component: k8s_self::K8sComponent,
}

#[derive(Deserialize)]
pub struct SelfPodLogsQuery {
    #[serde(default)]
    pub component: k8s_self::K8sComponent,
    #[serde(default = "default_log_tail_lines")]
    pub tail_lines: u32,
    pub container: Option<String>,
    #[serde(default)]
    pub previous: bool,
    #[serde(default)]
    pub timestamps: bool,
}

fn default_log_tail_lines() -> u32 {
    500
}

pub async fn admin_k8s_self_pod(
    AuthenticatedUser(_): AuthenticatedUser,
    Query(q): Query<K8sComponentQuery>,
) -> Result<Json<k8s_self::SelfPodStatusResponse>, AppError> {
    let cluster = k8s_self::K8sClusterAccess::from_env()?;
    let pod = cluster.resolve_pod(q.component)?;
    let status = k8s_self::get_pod_status(&cluster, &pod).await?;
    Ok(Json(status))
}

pub async fn admin_k8s_self_logs(
    AuthenticatedUser(_): AuthenticatedUser,
    Query(query): Query<SelfPodLogsQuery>,
) -> Result<Json<k8s_self::SelfPodLogsResponse>, AppError> {
    let cluster = k8s_self::K8sClusterAccess::from_env()?;
    let pod = cluster.resolve_pod(query.component)?;
    let logs = k8s_self::get_pod_logs(
        &cluster,
        &pod,
        k8s_self::LogQuery {
            tail_lines: query.tail_lines,
            container: query.container,
            previous: query.previous,
            timestamps: query.timestamps,
        },
    )
    .await?;
    Ok(Json(logs))
}

pub async fn admin_list_image_worker_logs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<Vec<AdminImageWorkerLog>>, AppError> {
    let logs = image_worker_logs::list_latest(&state.db, 1000).await?;
    Ok(Json(
        logs
            .into_iter()
            .map(|l| AdminImageWorkerLog {
                id: l.id.to_string(),
                run_id: l.run_id,
                level: l.level,
                message: l.message,
                data_json: serde_json::from_str(&l.data_json)
                    .unwrap_or_else(|_| serde_json::json!({ "raw": l.data_json })),
                created_at: l.created_at.to_rfc3339(),
            })
            .collect(),
    ))
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// Returns the token only when it is present and non-empty; otherwise `None`
/// (the field is simply omitted from the connection check).
fn present_token(token: &Option<String>) -> Option<&str> {
    token.as_deref().filter(|t| !t.is_empty())
}

fn into_result(probe: connection::TokenProbe) -> TokenCheckResult {
    TokenCheckResult { ok: probe.ok, error: probe.error }
}

fn parse_id(value: &str) -> Result<i64, AppError> {
    value.parse::<i64>().map_err(|_| AppError::BadRequest("invalid job id".into()))
}
