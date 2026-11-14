use crate::{
    db::langgraph::LanggraphJob,
    error::AppError,
    middleware::AuthenticatedUser,
    routes::job_common::{CancelJobResponse, StartJobResponse, parse_id},
    services::langgraph as service,
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::IntoResponse,
};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

pub async fn list_capabilities(
    State(s): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<Vec<crate::offload::CapabilityInfo>>, AppError> {
    Ok(Json(service::list_capabilities(&s).await?))
}
pub async fn start_job(
    State(s): State<Arc<AppState>>,
    AuthenticatedUser(u): AuthenticatedUser,
    Json(req): Json<service::StartJobParams>,
) -> Result<impl IntoResponse, AppError> {
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse::submitted(
            service::start_job(&s, u, req).await?,
        )),
    ))
}
#[derive(Serialize)]
pub struct JobResponse {
    job_id: String,
    status: String,
    capability: String,
    prompt: String,
    request: service::StartJobParams,
    result: Option<Value>,
    artifacts: Vec<service::Artifact>,
    stage: Option<String>,
    error: Option<String>,
    offload_cap: Option<String>,
    offload_task_id: Option<String>,
    created_at: String,
    updated_at: String,
}
fn response(job: LanggraphJob) -> Result<JobResponse, AppError> {
    let invalid = |e| AppError::Internal(format!("Invalid saved LangGraph run: {e}"));
    Ok(JobResponse {
        job_id: job.id.to_string(),
        status: job.status,
        capability: job.capability,
        prompt: job.prompt,
        request: serde_json::from_str(&job.request_json).map_err(invalid)?,
        result: job
            .result_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(invalid)?,
        artifacts: serde_json::from_str(&job.artifacts_json).map_err(invalid)?,
        stage: job.stage,
        error: job.error,
        offload_cap: job.offload_cap,
        offload_task_id: job.offload_task_id,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    })
}
#[derive(Serialize)]
pub struct JobSummary {
    job_id: String,
    status: String,
    capability: String,
    prompt: String,
    created_at: String,
    updated_at: String,
}
pub async fn list_jobs(
    State(s): State<Arc<AppState>>,
    AuthenticatedUser(u): AuthenticatedUser,
) -> Result<Json<Vec<JobSummary>>, AppError> {
    Ok(Json(
        service::list_jobs(&s, u)
            .await?
            .into_iter()
            .map(|job| JobSummary {
                job_id: job.id.to_string(),
                status: job.status,
                capability: job.capability,
                prompt: job.prompt,
                created_at: job.created_at.to_rfc3339(),
                updated_at: job.updated_at.to_rfc3339(),
            })
            .collect(),
    ))
}
pub async fn get_job(
    State(s): State<Arc<AppState>>,
    AuthenticatedUser(u): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<JobResponse>, AppError> {
    Ok(Json(response(
        service::get_job(&s, u, parse_id(&id, "job_id")?).await?,
    )?))
}
pub async fn poll_job(
    State(s): State<Arc<AppState>>,
    AuthenticatedUser(u): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<JobResponse>, AppError> {
    Ok(Json(response(
        service::poll_job(&s, u, parse_id(&id, "job_id")?).await?,
    )?))
}
pub async fn cancel_job(
    State(s): State<Arc<AppState>>,
    AuthenticatedUser(u): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<CancelJobResponse>, AppError> {
    Ok(Json(
        service::cancel_job(&s, u, parse_id(&id, "job_id")?)
            .await?
            .into(),
    ))
}
pub async fn retry_job(
    State(s): State<Arc<AppState>>,
    AuthenticatedUser(u): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse::submitted(
            service::retry_job(&s, u, parse_id(&id, "job_id")?).await?,
        )),
    ))
}
pub async fn delete_job(
    State(s): State<Arc<AppState>>,
    AuthenticatedUser(u): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    service::delete_job(&s, u, parse_id(&id, "job_id")?).await?;
    Ok(StatusCode::NO_CONTENT)
}
pub async fn get_artifact(
    State(s): State<Arc<AppState>>,
    AuthenticatedUser(u): AuthenticatedUser,
    Path((id, index)): Path<(String, usize)>,
) -> Result<impl IntoResponse, AppError> {
    let (bytes, meta) = service::artifact_bytes(&s, u, parse_id(&id, "job_id")?, index).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"artifact\"; filename*=UTF-8''{}",
            urlencoding::encode(&meta.filename)
        ))
        .map_err(|e| AppError::Internal(e.to_string()))?,
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok((headers, bytes))
}
