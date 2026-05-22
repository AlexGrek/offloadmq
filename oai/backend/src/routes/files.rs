//! Read-only file browser for the authenticated user.
//!
//! RBAC: every query is scoped to the caller's `user_id`, so a user can only
//! ever see their own files. This surface is intentionally read-only — there are
//! no upload/delete handlers here (no "pushes"). File *content* is served by the
//! existing `GET /api/images/files/{id}` endpoint, which enforces the same
//! ownership check.

use std::sync::Arc;

use axum::{extract::State, Json};
use serde::Serialize;

use crate::{
    db::image_generation, error::AppError, middleware::AuthenticatedUser,
    services::image_jobs, state::AppState,
};

/// Cap on how many files a single browse request returns.
const FILE_LIST_LIMIT: u64 = 500;

#[derive(Serialize)]
pub struct UserFile {
    pub id: String,
    pub direction: String,
    pub source: String,
    pub filename: String,
    pub content_type: String,
    pub width: i32,
    pub height: i32,
    pub size_bytes: i64,
    pub sha256: String,
    pub job_id: Option<String>,
    pub created_at: String,
    /// URL that serves the file bytes (same ownership check applies).
    pub url: String,
    /// True when the content type is an image and can be previewed inline.
    pub is_image: bool,
}

#[derive(Serialize)]
pub struct StorageSummary {
    /// Cached value read from `users.used_storage_bytes`.
    pub used_bytes: i64,
    pub file_count: i64,
    pub input_bytes: i64,
    pub output_bytes: i64,
}

#[derive(Serialize)]
pub struct FileBrowserResponse {
    pub files: Vec<UserFile>,
    pub summary: StorageSummary,
}

pub async fn list_files(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<FileBrowserResponse>, AppError> {
    let listing = image_jobs::list_user_files(&state, user_id, FILE_LIST_LIMIT).await?;

    let mut input_bytes = 0i64;
    let mut output_bytes = 0i64;
    let file_count = listing.files.len() as i64;
    let files: Vec<UserFile> = listing
        .files
        .into_iter()
        .map(|f| {
            if f.direction == "output" {
                output_bytes += f.stored_bytes;
            } else {
                input_bytes += f.stored_bytes;
            }
            map_user_file(f)
        })
        .collect();

    Ok(Json(FileBrowserResponse {
        files,
        summary: StorageSummary {
            used_bytes: listing.used_bytes,
            file_count,
            input_bytes,
            output_bytes,
        },
    }))
}

fn map_user_file(f: image_generation::ImageFile) -> UserFile {
    let is_image = f.content_type.starts_with("image/");
    UserFile {
        url: format!("/api/images/files/{}", f.id),
        id: f.id.to_string(),
        direction: f.direction,
        source: f.source,
        filename: f.filename,
        content_type: f.content_type,
        width: f.stored_width,
        height: f.stored_height,
        size_bytes: f.stored_bytes,
        sha256: f.sha256,
        job_id: f.job_id.map(|id| id.to_string()),
        created_at: f.created_at.to_rfc3339(),
        is_image,
    }
}
