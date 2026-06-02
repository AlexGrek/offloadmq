//! File browser for the authenticated user (list + bulk cleanup).
//!
//! RBAC: every query is scoped to the caller's `user_id`. File bytes are served by
//! `GET /api/images/files/{id}` with the same ownership check.

use std::sync::Arc;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use axum::extract::Query;

use crate::{
    db::{generation_parameters, image_generation, tts},
    error::AppError,
    middleware::AuthenticatedUser,
    services::image_jobs,
    state::AppState,
};

/// Cap on how many files a single browse request returns.
const FILE_LIST_LIMIT: u64 = 500;

#[derive(Serialize)]
pub struct UserFile {
    pub id: String,
    /// Discriminator for the row's storage origin: `"image"` (image_files) or
    /// `"audio"` (synthesized tts_jobs). Frontend uses this to pick the right
    /// delete endpoint and render mode.
    pub kind: String,
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
    /// URL that serves the full bytes (same ownership check applies).
    pub url: String,
    /// URL for the stored thumbnail JPEG (grid previews) — empty for audio.
    pub thumbnail_url: String,
    /// True when the content type is an image and can be previewed inline.
    pub is_image: bool,
    /// True when the content type is audio.
    pub is_audio: bool,
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

#[derive(Deserialize)]
pub struct CleanupFilesRequest {
    /// `uploads` (input), `generated` (output), or `all`.
    pub scope: String,
    #[serde(default = "default_keep_starred")]
    pub keep_starred: bool,
}

fn default_keep_starred() -> bool {
    true
}

#[derive(Serialize)]
pub struct CleanupFilesResponse {
    pub deleted_count: u64,
    pub skipped_starred: u64,
}

pub async fn cleanup_files(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<CleanupFilesRequest>,
) -> Result<Json<CleanupFilesResponse>, AppError> {
    let scope = image_jobs::CleanupFilesScope::parse(&req.scope)?;
    let out = image_jobs::cleanup_user_files(&state, user_id, scope, req.keep_starred).await?;
    Ok(Json(CleanupFilesResponse {
        deleted_count: out.deleted_count,
        skipped_starred: out.skipped_starred,
    }))
}

pub async fn list_files(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<FileBrowserResponse>, AppError> {
    let listing = image_jobs::list_user_files(&state, user_id, FILE_LIST_LIMIT).await?;

    let mut input_bytes = 0i64;
    let mut output_bytes = 0i64;
    let mut files: Vec<UserFile> = listing
        .files
        .into_iter()
        .map(|f| {
            let file_bytes = f.stored_bytes + f.thumbnail_stored_bytes;
            if f.direction == "output" {
                output_bytes += file_bytes;
            } else {
                input_bytes += file_bytes;
            }
            map_user_file(f)
        })
        .collect();

    let audio_jobs = tts::list_jobs(&state.db, user_id, FILE_LIST_LIMIT).await?;
    for job in audio_jobs {
        let Some(audio) = map_audio_job(&job) else {
            continue;
        };
        output_bytes += audio.size_bytes;
        files.push(audio);
    }

    files.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    let file_count = files.len() as i64;
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
        thumbnail_url: format!("/api/images/files/{}/thumbnail", f.id),
        id: f.id.to_string(),
        kind: "image".to_string(),
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
        is_audio: false,
    }
}

#[derive(Deserialize)]
pub struct FilePropertiesQuery {
    pub filename: String,
}

#[derive(Serialize)]
pub struct FilePropertiesResponse {
    pub filename: String,
    pub source: String,
    pub parameters: serde_json::Value,
    pub created_at: String,
}

/// Look up the generation parameters for a file by filename. Returns 404 if
/// no row exists (e.g. older file generated before this table existed, or an
/// upload — uploads don't record parameters).
pub async fn get_file_properties(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Query(query): Query<FilePropertiesQuery>,
) -> Result<Json<FilePropertiesResponse>, AppError> {
    let row = generation_parameters::get_by_filename(&state.db, user_id, &query.filename)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(FilePropertiesResponse {
        filename: row.filename,
        source: row.source,
        parameters: row.parameters,
        created_at: row.created_at.to_rfc3339(),
    }))
}

/// Map a completed TTS job into a `UserFile` row. Returns `None` until the
/// audio blob has been written.
fn map_audio_job(job: &tts::TtsJob) -> Option<UserFile> {
    if job.status != "completed" {
        return None;
    }
    let path = job.audio_storage_path.as_deref()?;
    let content_type = job
        .audio_content_type
        .clone()
        .unwrap_or_else(|| "audio/wav".to_string());
    let size_bytes = job.audio_size_bytes.unwrap_or(0);
    let filename = path
        .rsplit('/')
        .next()
        .unwrap_or("audio.wav")
        .to_string();
    Some(UserFile {
        url: format!("/api/tts/jobs/{}/audio", job.id),
        thumbnail_url: String::new(),
        id: job.id.to_string(),
        kind: "audio".to_string(),
        direction: "output".to_string(),
        source: "tts".to_string(),
        filename,
        content_type,
        width: 0,
        height: 0,
        size_bytes,
        sha256: String::new(),
        job_id: Some(job.id.to_string()),
        created_at: job.created_at.to_rfc3339(),
        is_image: false,
        is_audio: true,
    })
}
