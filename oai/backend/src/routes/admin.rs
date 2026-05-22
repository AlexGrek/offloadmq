use std::sync::Arc;

use axum::{extract::{Path, State}, Json};
use serde::{Deserialize, Serialize};

use crate::{
    db::{app_settings, image_generation, image_worker_logs, users},
    error::AppError,
    middleware::AuthenticatedUser,
    routes::images::{self, JobDetailsResponse},
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
    let base = req.offloadmq_url.trim_end_matches('/');

    let client_result = match req.client_api_token {
        None => None,
        Some(token) if token.is_empty() => None,
        Some(token) => {
            let url = format!("{base}/api/capabilities/online");
            let result = state
                .http
                .get(&url)
                .header("X-API-Key", &token)
                .send()
                .await;
            Some(match result {
                Ok(resp) if resp.status().is_success() => TokenCheckResult { ok: true, error: None },
                Ok(resp) if resp.status() == 401 || resp.status() == 403 => {
                    TokenCheckResult { ok: false, error: Some("Invalid client token".to_string()) }
                }
                Ok(resp) => TokenCheckResult {
                    ok: false,
                    error: Some(format!("Unexpected status {}", resp.status())),
                },
                Err(e) => TokenCheckResult { ok: false, error: Some(e.to_string()) },
            })
        }
    };

    let management_result = match req.management_api_token {
        None => None,
        Some(token) if token.is_empty() => None,
        Some(token) => {
            let url = format!("{base}/management/version");
            let result = state
                .http
                .get(&url)
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await;
            Some(match result {
                Ok(resp) if resp.status().is_success() => TokenCheckResult { ok: true, error: None },
                Ok(resp) if resp.status() == 401 || resp.status() == 403 => {
                    TokenCheckResult { ok: false, error: Some("Invalid management token".to_string()) }
                }
                Ok(resp) => TokenCheckResult {
                    ok: false,
                    error: Some(format!("Unexpected status {}", resp.status())),
                },
                Err(e) => TokenCheckResult { ok: false, error: Some(e.to_string()) },
            })
        }
    };

    Ok(Json(CheckConnectionResponse {
        client_token: client_result,
        management_token: management_result,
    }))
}

pub async fn admin_list_image_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<Vec<JobDetailsResponse>>, AppError> {
    let jobs = image_generation::list_jobs_global(&state.db, 200).await?;
    let mut out = Vec::with_capacity(jobs.len());
    for job in jobs {
        let files = image_generation::list_job_files(&state.db, job.id).await?;
        let events = image_generation::list_pipeline_events(&state.db, job.id).await?;
        out.push(JobDetailsResponse {
            job_id: job.id.to_string(),
            status: job.status,
            prompt: job.prompt,
            negative_prompt: job.negative_prompt,
            capability: job.capability,
            workflow: job.workflow,
            width: job.width,
            height: job.height,
            seed: job.seed,
            input_image_id: job.input_image_id.map(|id| id.to_string()),
            error: job.error,
            files: files
                .into_iter()
                .map(|f| images::JobFile {
                    image_id: f.id.to_string(),
                    direction: f.direction,
                    source: f.source,
                    filename: f.filename,
                    content_type: f.content_type,
                    width: f.stored_width,
                    height: f.stored_height,
                    size_bytes: f.stored_bytes,
                    rescaled: f.rescaled,
                    reencoded: f.reencoded,
                })
                .collect(),
            events: events
                .into_iter()
                .map(|e| images::JobEvent {
                    step: e.step,
                    state: e.state,
                    details: e.details,
                    created_at: e.created_at.to_rfc3339(),
                })
                .collect(),
        });
    }
    Ok(Json(out))
}

pub async fn admin_get_image_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Path(job_id): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = job_id.parse::<i64>().map_err(|_| AppError::BadRequest("invalid job id".into()))?;
    let job = image_generation::get_job_global(&state.db, job_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let files = image_generation::list_job_files(&state.db, job.id).await?;
    let events = image_generation::list_pipeline_events(&state.db, job.id).await?;
    Ok(Json(JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        prompt: job.prompt,
        negative_prompt: job.negative_prompt,
        capability: job.capability,
        workflow: job.workflow,
        width: job.width,
        height: job.height,
        seed: job.seed,
        input_image_id: job.input_image_id.map(|id| id.to_string()),
        error: job.error,
        files: files
            .into_iter()
            .map(|f| images::JobFile {
                image_id: f.id.to_string(),
                direction: f.direction,
                source: f.source,
                filename: f.filename,
                content_type: f.content_type,
                width: f.stored_width,
                height: f.stored_height,
                size_bytes: f.stored_bytes,
                rescaled: f.rescaled,
                reencoded: f.reencoded,
            })
            .collect(),
        events: events
            .into_iter()
            .map(|e| images::JobEvent {
                step: e.step,
                state: e.state,
                details: e.details,
                created_at: e.created_at.to_rfc3339(),
            })
            .collect(),
    }))
}

pub async fn admin_reconcile_image_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Path(job_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let job_id = job_id.parse::<i64>().map_err(|_| AppError::BadRequest("invalid job id".into()))?;
    let job = image_generation::get_job_global(&state.db, job_id)
        .await?
        .ok_or(AppError::NotFound)?;
    images::reconcile_job_outputs_if_missing(&state, &job, job.user_id).await?;
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
