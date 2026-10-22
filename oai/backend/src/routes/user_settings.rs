use crate::{
    db::prompt_defaults::{self, PromptDefaults},
    error::AppError,
    middleware::AuthenticatedUser,
    state::AppState,
};
use axum::{Json, extract::State};
use std::sync::Arc;

pub async fn get_prompt_defaults(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<PromptDefaults>, AppError> {
    Ok(Json(prompt_defaults::get(&state.db, user_id).await?))
}

pub async fn save_prompt_defaults(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(prompts): Json<PromptDefaults>,
) -> Result<Json<PromptDefaults>, AppError> {
    Ok(Json(
        prompt_defaults::save(&state.db, user_id, prompts).await?,
    ))
}
