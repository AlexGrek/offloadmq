use std::sync::Arc;

use axum::{extract::{Query, State}, Json};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    services::image_job_names,
    state::AppState,
};

#[derive(Deserialize)]
pub struct RandomNamesQuery {
    pub count: Option<usize>,
}

#[derive(Serialize)]
pub struct RandomNamesResponse {
    pub names: Vec<image_job_names::GeneratedName>,
}

pub async fn random_names(
    State(_state): State<Arc<AppState>>,
    AuthenticatedUser(_user_id): AuthenticatedUser,
    Query(query): Query<RandomNamesQuery>,
) -> Result<Json<RandomNamesResponse>, AppError> {
    let count = query.count.unwrap_or(6);
    Ok(Json(RandomNamesResponse {
        names: image_job_names::generate_random_names(count),
    }))
}
