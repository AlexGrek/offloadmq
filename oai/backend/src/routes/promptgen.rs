use std::sync::Arc;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    offload::LlmCapabilityInfo,
    services::promptgen,
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<LlmCapabilityInfo>,
}

/// `GET /api/promptgen/capabilities` — text LLMs usable for prompt generation.
pub async fn list_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    let capabilities = promptgen::list_llm_capabilities(&state).await?;
    Ok(Json(CapabilitiesResponse { capabilities }))
}

#[derive(Deserialize)]
pub struct GenerateRequest {
    /// Generation mode the query belongs to (`txt2img`, `img2img`, …) — selects
    /// the prompt-library bucket the query is recorded into.
    pub mode: String,
    pub capability: String,
    /// Query template; must contain `{}`.
    pub query: String,
    /// User's prompt substituted for `{}`.
    pub prompt: String,
}

#[derive(Serialize)]
pub struct GenerateResponse {
    pub cap: String,
    pub id: String,
}

/// `POST /api/promptgen/generate` — submit the LLM task; poll with
/// `/api/promptgen/poll`, cancel with the generic `/api/tasks/cancel/{cap}/{id}`.
pub async fn generate(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<GenerateRequest>,
) -> Result<Json<GenerateResponse>, AppError> {
    let task_id = promptgen::generate(
        &state,
        user_id,
        promptgen::GenerateParams {
            mode: req.mode,
            capability: req.capability,
            query: req.query,
            prompt: req.prompt,
        },
    )
    .await?;
    Ok(Json(GenerateResponse { cap: task_id.cap, id: task_id.id }))
}

#[derive(Deserialize)]
pub struct PollRequest {
    pub cap: String,
    pub id: String,
}

#[derive(Serialize)]
pub struct PollResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `POST /api/promptgen/poll` — task status; `text` is set once completed.
pub async fn poll(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Json(req): Json<PollRequest>,
) -> Result<Json<PollResponse>, AppError> {
    let result = promptgen::poll(&state, &req.cap, &req.id).await?;
    Ok(Json(PollResponse {
        status: result.status,
        stage: result.stage,
        text: result.text,
        error: result.error,
    }))
}
