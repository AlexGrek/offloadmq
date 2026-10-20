use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    routes::job_common::{StartJobResponse, parse_id},
    services::image_cycles::{self as service, Params, View},
    state::AppState,
};
use axum::{
    Extension, Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get as get_route, post},
};
use std::sync::Arc;

#[derive(Clone)]
struct AppKind(&'static str);

pub fn router(app: &'static str) -> Router<Arc<AppState>> {
    Router::new()
        .route("/jobs", post(start).get(list))
        .route("/jobs/{id}", get_route(get).delete(delete))
        .route("/jobs/{id}/poll", post(poll))
        .route("/jobs/{id}/cancel", post(cancel))
        .route("/jobs/{id}/retry", post(retry))
        .layer(Extension(AppKind(app)))
}

async fn owned_id(state: &AppState, user: i64, id: &str, app: &str) -> Result<i64, AppError> {
    let id = parse_id(id, "job_id")?;
    if service::get(state, user, id).await?.app != app {
        return Err(AppError::NotFound);
    }
    Ok(id)
}

async fn start(
    Extension(AppKind(app)): Extension<AppKind>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Json(p): Json<Params>,
) -> Result<(StatusCode, Json<StartJobResponse>), AppError> {
    let id = service::start_for_app(&state, user, p, app).await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(id))))
}
async fn list(
    Extension(AppKind(app)): Extension<AppKind>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
) -> Result<Json<Vec<View>>, AppError> {
    Ok(Json(service::list(&state, user, app).await?))
}
async fn get(
    Extension(AppKind(app)): Extension<AppKind>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<View>, AppError> {
    Ok(Json(
        service::get(&state, user, owned_id(&state, user, &id, app).await?).await?,
    ))
}
async fn poll(
    Extension(AppKind(app)): Extension<AppKind>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<View>, AppError> {
    Ok(Json(
        service::poll(&state, user, owned_id(&state, user, &id, app).await?).await?,
    ))
}
async fn cancel(
    Extension(AppKind(app)): Extension<AppKind>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<View>, AppError> {
    Ok(Json(
        service::cancel(&state, user, owned_id(&state, user, &id, app).await?).await?,
    ))
}
async fn retry(
    Extension(AppKind(app)): Extension<AppKind>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<StartJobResponse>), AppError> {
    let id = service::retry(&state, user, owned_id(&state, user, &id, app).await?).await?;
    Ok((StatusCode::CREATED, Json(StartJobResponse::submitted(id))))
}
async fn delete(
    Extension(AppKind(app)): Extension<AppKind>,
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    service::delete(&state, user, owned_id(&state, user, &id, app).await?).await?;
    Ok(StatusCode::NO_CONTENT)
}
