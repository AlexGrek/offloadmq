use std::sync::Arc;

use axum::{extract::State, Json};

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    services::progress,
    state::AppState,
};

pub async fn running_jobs(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<progress::RunningJobsResponse>, AppError> {
    Ok(Json(progress::list_running_image_jobs(&state, user_id).await?))
}
