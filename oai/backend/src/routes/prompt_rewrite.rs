use std::sync::Arc;

use axum::{Json, extract::State};
use serde::Serialize;

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    offload::LlmCapabilityInfo,
    services::{
        prompt_rewrite::{self, RewritePromptParams},
        promptgen,
    },
    state::AppState,
};

pub async fn capabilities(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<LlmCapabilityInfo>>, AppError> {
    // Urgent requests cannot wait for an offline model to return.
    Ok(Json(
        promptgen::list_llm_capabilities(&state)
            .await?
            .into_iter()
            .filter(|cap| cap.online)
            .collect(),
    ))
}

#[derive(Serialize)]
pub struct RewritePromptResponse {
    text: String,
}

pub async fn rewrite(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(params): Json<RewritePromptParams>,
) -> Result<Json<RewritePromptResponse>, AppError> {
    let text = prompt_rewrite::rewrite_prompt(&state, user_id, params).await?;
    Ok(Json(RewritePromptResponse { text }))
}
