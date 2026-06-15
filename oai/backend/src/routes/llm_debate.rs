use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::prompts,
    error::AppError,
    middleware::AuthenticatedUser,
    routes::job_common::{parse_id, CancelJobResponse, StartJobResponse},
    services::llm_debate as service,
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<crate::offload::LlmCapabilityInfo>,
}

pub async fn list_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    let capabilities = service::list_capabilities(&state).await?;
    Ok(Json(CapabilitiesResponse { capabilities }))
}

#[derive(Deserialize)]
pub struct StartJobRequest {
    pub model_a: String,
    pub model_b: String,
    pub system_a: Option<String>,
    pub system_b: Option<String>,
    pub initial_prompt: String,
    pub referee_enabled: Option<bool>,
    pub model_ref: Option<String>,
    pub system_ref: Option<String>,
    pub command_ref: Option<String>,
    pub referee_turns: Option<i32>,
}

pub async fn start_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<StartJobRequest>,
) -> Result<impl IntoResponse, AppError> {
    let system_a = req
        .system_a
        .as_deref()
        .unwrap_or("You are a helpful AI assistant.");
    let system_b = req
        .system_b
        .as_deref()
        .unwrap_or("You are a helpful AI assistant.");
    let referee_enabled = req.referee_enabled.unwrap_or(false);

    if !system_a.trim().is_empty() {
        let _ = prompts::record_use(
            &state.db,
            || state.next_id(),
            user_id,
            "llm-debate-system-a",
            system_a,
        )
        .await;
    }
    if !system_b.trim().is_empty() {
        let _ = prompts::record_use(
            &state.db,
            || state.next_id(),
            user_id,
            "llm-debate-system-b",
            system_b,
        )
        .await;
    }
    if !req.initial_prompt.trim().is_empty() {
        let _ = prompts::record_use(
            &state.db,
            || state.next_id(),
            user_id,
            "llm-debate-initial",
            &req.initial_prompt,
        )
        .await;
    }
    if referee_enabled {
        if let Some(s) = req.system_ref.as_deref().filter(|t| !t.trim().is_empty()) {
            let _ = prompts::record_use(
                &state.db,
                || state.next_id(),
                user_id,
                "llm-debate-referee-system",
                s,
            )
            .await;
        }
        if let Some(c) = req.command_ref.as_deref().filter(|t| !t.trim().is_empty()) {
            let _ = prompts::record_use(
                &state.db,
                || state.next_id(),
                user_id,
                "llm-debate-referee-command",
                c,
            )
            .await;
        }
    }

    let job_id = service::start_job(
        &state,
        user_id,
        service::StartJobParams {
            model_a: req.model_a,
            model_b: req.model_b,
            system_a: system_a.to_string(),
            system_b: system_b.to_string(),
            initial_prompt: req.initial_prompt,
            referee_enabled,
            model_ref: req.model_ref,
            system_ref: req.system_ref,
            command_ref: req.command_ref,
            referee_turns: req.referee_turns.unwrap_or(6),
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(job_id))))
}

pub type JobDetailsResponse = service::DebateJobView;

pub async fn list_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<JobDetailsResponse>>, AppError> {
    let jobs = service::list_user_jobs(&state, user_id, 100).await?;
    let out = jobs
        .into_iter()
        .map(service::job_view)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(out))
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::user_job_detail(&state, job_id, user_id).await?;
    Ok(Json(service::job_view(job)?))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::poll_job(&state, user_id, job_id).await?;
    Ok(Json(service::job_view(job)?))
}

pub async fn cancel_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<CancelJobResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let out = service::cancel_job(&state, user_id, job_id).await?;
    Ok(Json(out.into()))
}

pub async fn retry_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let new_id = service::retry_job(&state, user_id, job_id).await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(new_id))))
}

pub async fn delete_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<StatusCode, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    service::delete_job(&state, user_id, job_id).await?;
    Ok(StatusCode::NO_CONTENT)
}
