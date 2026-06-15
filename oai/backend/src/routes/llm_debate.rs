use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::{llm_debate, prompts},
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

#[derive(Serialize)]
pub struct DebateMessageResponse {
    pub side: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct JobDetailsResponse {
    pub job_id: String,
    pub status: String,
    pub model_a: String,
    pub model_b: String,
    pub system_a: String,
    pub system_b: String,
    pub initial_prompt: String,
    pub referee_enabled: bool,
    pub model_ref: Option<String>,
    pub system_ref: Option<String>,
    pub command_ref: Option<String>,
    pub referee_turns: i32,
    pub messages: Vec<DebateMessageResponse>,
    pub phase: String,
    pub current_turn: Option<String>,
    pub active_log: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub async fn list_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<Vec<JobDetailsResponse>>, AppError> {
    let jobs = service::list_user_jobs(&state, user_id, 100).await?;
    Ok(Json(jobs.into_iter().map(job_details_response).collect()))
}

pub async fn get_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::user_job_detail(&state, job_id, user_id).await?;
    Ok(Json(job_details_response(job)))
}

pub async fn poll_job(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(job_id_str): Path<String>,
) -> Result<Json<JobDetailsResponse>, AppError> {
    let job_id = parse_id(&job_id_str, "job_id")?;
    let job = service::poll_job(&state, user_id, job_id).await?;
    Ok(Json(job_details_response(job)))
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

fn job_details_response(job: llm_debate::LlmDebateJob) -> JobDetailsResponse {
    let messages = service::parse_job_messages(&job)
        .unwrap_or_default()
        .into_iter()
        .map(|m| DebateMessageResponse {
            side: m.side,
            content: m.content,
        })
        .collect();
    JobDetailsResponse {
        job_id: job.id.to_string(),
        status: job.status,
        model_a: job.model_a,
        model_b: job.model_b,
        system_a: job.system_a,
        system_b: job.system_b,
        initial_prompt: job.initial_prompt,
        referee_enabled: job.referee_enabled,
        model_ref: job.model_ref,
        system_ref: job.system_ref,
        command_ref: job.command_ref,
        referee_turns: job.referee_turns,
        messages,
        phase: job.phase,
        current_turn: job.current_turn,
        active_log: job.active_log,
        stage: job.stage,
        error: job.error,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    }
}
