use crate::{
    db::prompt_defaults::{self, PromptDefaults},
    db::reverse_exclusions::{self, ReverseExclusions},
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

pub async fn get_reverse_exclusions(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<ReverseExclusions>, AppError> {
    Ok(Json(reverse_exclusions::get(&state.db, user_id).await?))
}

pub async fn save_reverse_exclusions(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(body): Json<ReverseExclusions>,
) -> Result<Json<ReverseExclusions>, AppError> {
    Ok(Json(
        reverse_exclusions::save(&state.db, user_id, body).await?,
    ))
}
