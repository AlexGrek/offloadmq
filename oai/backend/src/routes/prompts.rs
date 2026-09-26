use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    db::prompts::{self, PageCursor},
    error::AppError,
    middleware::AuthenticatedUser,
    services::prompt_previews,
    state::AppState,
};

#[derive(Serialize)]
pub struct PromptItem {
    pub id: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct PromptLibraryResponse {
    pub recent: Vec<PromptItem>,
    pub starred: Vec<PromptItem>,
}

/// A saved prompt as the paged library drawer sees it.
#[derive(Serialize)]
pub struct PromptEntryDto {
    pub id: String,
    pub kind: String,
    pub content: String,
    pub created_at: String,
    pub last_used_at: String,
    pub updated_at: String,
    /// Present when the entry has an image preview; append as `?v=` to the
    /// preview URL so a replaced preview is never served from cache.
    pub preview_version: Option<String>,
}

#[derive(Serialize)]
pub struct PromptPageResponse {
    pub items: Vec<PromptEntryDto>,
    pub next_cursor: Option<String>,
}

#[derive(Deserialize)]
pub struct ListEntriesQuery {
    pub kind: String,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u64>,
}

#[derive(Deserialize)]
pub struct ContentRequest {
    pub content: String,
}

fn to_item(m: prompts::PromptEntry) -> PromptItem {
    PromptItem {
        id: m.id.to_string(),
        content: m.content,
    }
}

fn to_dto(m: prompts::PromptEntry) -> PromptEntryDto {
    PromptEntryDto {
        id: m.id.to_string(),
        kind: m.kind,
        content: m.content,
        created_at: m.created_at.to_rfc3339(),
        last_used_at: m.last_used_at.to_rfc3339(),
        updated_at: m.updated_at.to_rfc3339(),
        preview_version: m.preview_updated_at.map(|t| t.timestamp_millis().to_string()),
    }
}

fn parse_id(id: &str) -> Result<i64, AppError> {
    id.parse().map_err(|_| AppError::BadRequest("invalid id".into()))
}

/// `GET /api/prompts/{bucket}` — recent + starred for one bucket, all at once.
/// Kept for API clients; the SPA uses the paged `/entries` listing.
pub async fn list_library(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(bucket): Path<String>,
) -> Result<Json<PromptLibraryResponse>, AppError> {
    let (recent, starred) = prompts::list_library(&state.db, user_id, &bucket).await?;
    Ok(Json(PromptLibraryResponse {
        recent: recent.into_iter().map(to_item).collect(),
        starred: starred.into_iter().map(to_item).collect(),
    }))
}

/// `GET /api/prompts/{bucket}/entries?kind=recent|starred&q=&cursor=&limit=` — one
/// keyset page of a bucket's list, newest first, optionally filtered by a
/// case-insensitive substring. `next_cursor` is null on the last page.
pub async fn list_entries(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(bucket): Path<String>,
    Query(query): Query<ListEntriesQuery>,
) -> Result<Json<PromptPageResponse>, AppError> {
    let cursor = query
        .cursor
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(PageCursor::parse)
        .transpose()?;
    let page = prompts::list_page(
        &state.db,
        user_id,
        &bucket,
        &query.kind,
        query.q.as_deref(),
        cursor,
        query.limit.unwrap_or(prompts::DEFAULT_PAGE_SIZE),
    )
    .await?;
    Ok(Json(PromptPageResponse {
        items: page.items.into_iter().map(to_dto).collect(),
        next_cursor: page.next_cursor.map(|c| c.encode()),
    }))
}

/// `POST /api/prompts/{bucket}/recent` — record a use, moving/inserting the
/// content at the head of the bucket's recent list. Callers control exactly
/// when a use is recorded, independent of any other action (e.g. image
/// generation records once per user submission — not once per job — so a
/// "generate multiple" batch doesn't flood recents with per-job variants).
pub async fn record_recent(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(bucket): Path<String>,
    Json(req): Json<ContentRequest>,
) -> Result<Json<PromptItem>, AppError> {
    let row = prompt_previews::record_use(&state, user_id, &bucket, &req.content).await?;
    Ok(Json(to_item(row)))
}

/// `POST /api/prompts/{bucket}/star` — add the given content to favorites.
pub async fn star(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(bucket): Path<String>,
    Json(req): Json<ContentRequest>,
) -> Result<Json<PromptItem>, AppError> {
    let row = prompts::add_starred(&state.db, || state.next_id(), user_id, &bucket, &req.content)
        .await?;
    Ok(Json(to_item(row)))
}

/// `PATCH /api/prompt-entries/{id}` — edit an owned entry (favorite). Returns the
/// full entry so the drawer can update the row in place.
pub async fn update_entry(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
    Json(req): Json<ContentRequest>,
) -> Result<Json<PromptEntryDto>, AppError> {
    let id = parse_id(&id)?;
    let row = prompt_previews::update_content(&state, user_id, id, &req.content).await?;
    Ok(Json(to_dto(row)))
}

/// `DELETE /api/prompt-entries/{id}` — remove an owned entry.
pub async fn delete_entry(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let id = parse_id(&id)?;
    prompt_previews::delete_entry(&state, user_id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/prompt-entries/{id}/preview` — the entry's preview thumbnail (JPEG).
/// Token via `?token=` for `<img src>`. Clients version the URL with `?v=`
/// (`preview_version`), so the response is cached aggressively.
pub async fn get_preview(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let id = parse_id(&id)?;
    let bytes = prompt_previews::preview_bytes(&state, user_id, id).await?;
    Ok((
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg")),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=31536000, immutable"),
            ),
        ],
        bytes,
    ))
}
