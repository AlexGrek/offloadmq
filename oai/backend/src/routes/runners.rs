use std::sync::Arc;

use axum::{extract::State, Json};
use serde::Serialize;

use crate::{error::AppError, middleware::AuthenticatedUser, services::runners, state::AppState};

#[derive(Debug, Serialize)]
pub struct ListRunnersResponse {
    pub runners: Vec<runners::RunnerSummary>,
}

pub async fn list_online(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<ListRunnersResponse>, AppError> {
    let runners = runners::list_online_runners(&state).await?;
    Ok(Json(ListRunnersResponse { runners }))
}
