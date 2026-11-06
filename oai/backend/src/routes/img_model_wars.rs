//! `/api/img-model-wars` — one prompt rendered by several imggen models.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get as get_route, post},
};

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    routes::job_common::{StartJobResponse, parse_id},
    services::img_model_wars::{self as service, Params, View},
    state::AppState,
};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/jobs", post(start).get(list))
        .route("/jobs/{id}", get_route(get).delete(delete))
        .route("/jobs/{id}/cancel", post(cancel))
        .route("/jobs/{id}/retry", post(retry))
}

async fn start(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Json(p): Json<Params>,
) -> Result<(StatusCode, Json<StartJobResponse>), AppError> {
    let id = service::start(&state, user, p).await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(id))))
}

async fn list(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
) -> Result<Json<Vec<View>>, AppError> {
    Ok(Json(service::list(&state, user).await?))
}

async fn get(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<View>, AppError> {
    Ok(Json(
        service::get(&state, user, parse_id(&id, "job_id")?).await?,
    ))
}

async fn cancel(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<View>, AppError> {
    Ok(Json(
        service::cancel(&state, user, parse_id(&id, "job_id")?).await?,
    ))
}

async fn retry(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<StartJobResponse>), AppError> {
    let new_id = service::retry(&state, user, parse_id(&id, "job_id")?).await?;
    Ok((
        StatusCode::CREATED,
        Json(StartJobResponse::submitted(new_id)),
    ))
}

async fn delete(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    service::delete(&state, user, parse_id(&id, "job_id")?).await?;
    Ok(StatusCode::NO_CONTENT)
}
