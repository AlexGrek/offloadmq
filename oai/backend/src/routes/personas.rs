//! `/api/personas/*` (persona CRUD, model options, photo start/list) and
//! `/api/persona-photos/*` (one photo run). Persona chats are ordinary chats:
//! `/api/chats?kind=persona&persona_id=…`.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    routes::job_common::parse_id,
    services::{
        persona_photos::{self, PhotoView, StartPhotoRequest},
        personas::{self, ModelOptions, PersonaInput, PersonaView},
    },
    state::AppState,
};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/options", get(options))
        .route("/{id}", get(detail).put(update).delete(delete))
        .route("/{id}/photos", get(list_photos).post(start_photos))
}

pub fn photos_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{id}", get(get_photo).delete(delete_photo))
        .route("/{id}/poll", post(poll_photo))
        .route("/{id}/cancel", post(cancel_photo))
        .route("/{id}/retry", post(retry_photo))
}

async fn list(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
) -> Result<Json<Vec<PersonaView>>, AppError> {
    let mut out = Vec::new();
    for p in personas::list(&state, user).await? {
        out.push(personas::view(&state, p, false).await?);
    }
    Ok(Json(out))
}

async fn create(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Json(input): Json<PersonaInput>,
) -> Result<(StatusCode, Json<PersonaView>), AppError> {
    let p = personas::create(&state, user, input).await?;
    Ok((
        StatusCode::CREATED,
        Json(personas::view(&state, p, false).await?),
    ))
}

async fn options(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
) -> Json<ModelOptions> {
    Json(personas::model_options(&state, user).await)
}

#[derive(Deserialize)]
struct DetailQuery {
    /// `false` skips resolving effective models (no OffloadMQ round trip).
    #[serde(default)]
    effective: Option<bool>,
}

async fn detail(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
    Query(q): Query<DetailQuery>,
) -> Result<Json<PersonaView>, AppError> {
    let p = personas::get(&state, user, parse_id(&id, "persona_id")?).await?;
    Ok(Json(
        personas::view(&state, p, q.effective.unwrap_or(true)).await?,
    ))
}

async fn update(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
    Json(input): Json<PersonaInput>,
) -> Result<Json<PersonaView>, AppError> {
    let p = personas::update(&state, user, parse_id(&id, "persona_id")?, input).await?;
    Ok(Json(personas::view(&state, p, false).await?))
}

async fn delete(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    personas::delete(&state, user, parse_id(&id, "persona_id")?).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ListPhotosQuery {
    #[serde(default)]
    limit: Option<u64>,
}

async fn list_photos(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
    Query(q): Query<ListPhotosQuery>,
) -> Result<Json<Vec<PhotoView>>, AppError> {
    let limit = q.limit.unwrap_or(100).clamp(1, 200);
    Ok(Json(
        persona_photos::list(&state, user, parse_id(&id, "persona_id")?, limit).await?,
    ))
}

#[derive(Serialize)]
struct StartPhotosResponse {
    job_ids: Vec<String>,
}

async fn start_photos(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
    Json(req): Json<StartPhotoRequest>,
) -> Result<(StatusCode, Json<StartPhotosResponse>), AppError> {
    let ids = persona_photos::start(&state, user, parse_id(&id, "persona_id")?, req).await?;
    Ok((
        StatusCode::CREATED,
        Json(StartPhotosResponse {
            job_ids: ids.iter().map(i64::to_string).collect(),
        }),
    ))
}

async fn get_photo(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<PhotoView>, AppError> {
    Ok(Json(
        persona_photos::get(&state, user, parse_id(&id, "job_id")?).await?,
    ))
}

async fn poll_photo(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<PhotoView>, AppError> {
    Ok(Json(
        persona_photos::poll(&state, user, parse_id(&id, "job_id")?, true).await?,
    ))
}

async fn cancel_photo(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<Json<PhotoView>, AppError> {
    Ok(Json(
        persona_photos::cancel(&state, user, parse_id(&id, "job_id")?).await?,
    ))
}

#[derive(Serialize)]
struct RetryResponse {
    job_id: String,
}

async fn retry_photo(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<RetryResponse>), AppError> {
    let new_id = persona_photos::retry(&state, user, parse_id(&id, "job_id")?).await?;
    Ok((
        StatusCode::CREATED,
        Json(RetryResponse {
            job_id: new_id.to_string(),
        }),
    ))
}

async fn delete_photo(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    persona_photos::delete(&state, user, parse_id(&id, "job_id")?).await?;
    Ok(StatusCode::NO_CONTENT)
}
