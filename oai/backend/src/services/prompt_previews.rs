//! Image previews for saved prompts, plus the prompt-library operations that must
//! keep those preview blobs consistent.
//!
//! A preview is a copy of the output thumbnail (`image_processing::THUMBNAIL_MAX_EDGE`)
//! of the latest image generated from a prompt — a copy, so deleting the source
//! image never breaks it. Blobs are keyed by content (`image_paths::prompt_preview_path`),
//! shared by every entry in the bucket with that text; `prompt_entries.preview_updated_at`
//! flags which entries have one. A blob is deleted once no entry references its
//! content any more.

use crate::{
    db::prompts::{self, PromptEntry},
    error::AppError,
    services::{image_paths, storage},
    state::AppState,
};

/// Store `thumb_jpeg` as the preview of `content` in `bucket` (replacing any older
/// one — the latest generation wins) and flag the matching entries. Best-effort:
/// a preview is a nicety, so failures are logged and never surface to the job.
pub async fn attach_preview(
    state: &AppState,
    user_id: i64,
    bucket: &str,
    content: &str,
    thumb_jpeg: Vec<u8>,
) {
    if let Err(e) = try_attach_preview(state, user_id, bucket, content, thumb_jpeg).await {
        tracing::warn!("prompt preview: attach failed for user {user_id} bucket {bucket}: {e}");
    }
}

async fn try_attach_preview(
    state: &AppState,
    user_id: i64,
    bucket: &str,
    content: &str,
    thumb_jpeg: Vec<u8>,
) -> Result<(), AppError> {
    let bucket = prompts::normalize_bucket(bucket)?;
    let content = prompts::normalize_content(content)?;
    // Only spend a storage write when some saved entry actually uses this text.
    if !prompts::content_referenced(&state.db, user_id, &bucket, &content).await? {
        return Ok(());
    }
    let op = storage::operator(state)?;
    let path = image_paths::prompt_preview_path(user_id, &bucket, &content);
    storage::write(op, &path, thumb_jpeg).await?;
    prompts::mark_preview(&state.db, user_id, &bucket, &content, chrono::Utc::now().fixed_offset())
        .await?;
    Ok(())
}

/// JPEG bytes of an owned entry's preview; `NotFound` when it has none.
pub async fn preview_bytes(state: &AppState, user_id: i64, entry_id: i64) -> Result<Vec<u8>, AppError> {
    let entry = prompts::find_owned(&state.db, user_id, entry_id).await?;
    if entry.preview_updated_at.is_none() {
        return Err(AppError::NotFound);
    }
    let op = storage::operator(state)?;
    let path = image_paths::prompt_preview_path(user_id, &entry.bucket, &entry.content);
    if !storage::exists(op, &path).await? {
        return Err(AppError::NotFound);
    }
    storage::read(op, &path).await
}

/// Delete the preview blobs of `removed` rows whose content no remaining entry
/// references. Best-effort.
async fn collect_orphans(state: &AppState, removed: &[PromptEntry]) {
    let Ok(op) = storage::operator(state) else { return };
    for row in removed.iter().filter(|r| r.preview_updated_at.is_some()) {
        match prompts::content_referenced(&state.db, row.user_id, &row.bucket, &row.content).await {
            Ok(true) => {}
            Ok(false) => {
                let path = image_paths::prompt_preview_path(row.user_id, &row.bucket, &row.content);
                if let Err(e) = storage::delete(op, &path).await {
                    tracing::warn!("prompt preview: cannot delete orphan {path}: {e}");
                }
            }
            Err(e) => tracing::warn!("prompt preview: orphan check failed for entry {}: {e}", row.id),
        }
    }
}

/// [`prompts::record_use`] plus cleanup of previews the recents trim orphaned.
pub async fn record_use(
    state: &AppState,
    user_id: i64,
    bucket: &str,
    content: &str,
) -> Result<PromptEntry, AppError> {
    let (entry, trimmed) =
        prompts::record_use(&state.db, || state.next_id(), user_id, bucket, content).await?;
    collect_orphans(state, &trimmed).await;
    Ok(entry)
}

/// [`prompts::update_content`], carrying the preview blob over to the new content's
/// path so an edited favorite keeps its image.
pub async fn update_content(
    state: &AppState,
    user_id: i64,
    id: i64,
    content: &str,
) -> Result<PromptEntry, AppError> {
    let (before, after) = prompts::update_content(&state.db, user_id, id, content).await?;
    if before.content == after.content || before.preview_updated_at.is_none() {
        return Ok(after);
    }
    if let Err(e) = copy_preview(state, &before, &after).await {
        tracing::warn!("prompt preview: cannot carry preview of entry {id} over an edit: {e}");
        prompts::clear_preview(&state.db, id).await?;
        return Ok(PromptEntry { preview_updated_at: None, ..after });
    }
    collect_orphans(state, &[before]).await;
    Ok(after)
}

async fn copy_preview(state: &AppState, from: &PromptEntry, to: &PromptEntry) -> Result<(), AppError> {
    let op = storage::operator(state)?;
    let src = image_paths::prompt_preview_path(from.user_id, &from.bucket, &from.content);
    let dst = image_paths::prompt_preview_path(to.user_id, &to.bucket, &to.content);
    // An entry that already had the new text keeps its own (newer) image.
    if storage::exists(op, &dst).await? {
        return Ok(());
    }
    let bytes = storage::read(op, &src).await?;
    storage::write(op, &dst, bytes).await
}

/// [`prompts::delete_entry`] plus cleanup of its preview if now unreferenced.
pub async fn delete_entry(state: &AppState, user_id: i64, id: i64) -> Result<(), AppError> {
    let removed = prompts::delete_entry(&state.db, user_id, id).await?;
    collect_orphans(state, &[removed]).await;
    Ok(())
}
