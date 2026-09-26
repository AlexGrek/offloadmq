//! User-facing file operations: serving bytes/thumbnails, starring, listing, and the
//! delete/cleanup paths (including deleting a whole job).

use super::*;

/// Removes a pipeline from history: deletes job-linked storage files, then the job row.
pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    image_generation::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;

    let files = image_generation::list_job_files(&state.db, job_id).await?;
    for file in files {
        purge_stored_image(state, &file).await.log_warn("purge stored image on job delete");
        image_generation::delete_image_file(&state.db, file.id, user_id).await?;
    }

    image_generation::delete_job(&state.db, job_id, user_id).await?;
    recalc_user_storage(state, user_id).await?;
    Ok(())
}

pub async fn image_bytes(
    state: &AppState,
    user_id: i64,
    image_id: i64,
) -> Result<(Vec<u8>, String), AppError> {
    let op = storage::operator(state)?;
    let file = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let bytes = storage::read(op, &file.storage_path).await?;
    if file.content_type.starts_with("video/") {
        return Ok((bytes, file.content_type));
    }
    let bytes =
        image_processing::ensure_jpeg_response_async(bytes, file.content_type.clone()).await?;
    Ok((bytes, "image/jpeg".to_string()))
}

pub async fn image_thumbnail_bytes(
    state: &AppState,
    user_id: i64,
    image_id: i64,
) -> Result<Vec<u8>, AppError> {
    let op = storage::operator(state)?;
    let file = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let is_video = file.content_type.starts_with("video/");
    let canonical_thumb = image_paths::thumbnail_path(user_id, image_id);
    let thumb_path = file
        .thumbnail_storage_path
        .clone()
        .filter(|p| p != &file.storage_path)
        .unwrap_or(canonical_thumb.clone());

    if let Ok(bytes) = storage::read(op, &thumb_path).await {
        if image_processing::is_jpeg_blob(&bytes, "image/jpeg") {
            return Ok(bytes);
        }
    }

    let main = storage::read(op, &file.storage_path).await?;
    let thumb_bytes = if is_video {
        image_processing::thumbnail_from_video_async(main).await?.0
    } else {
        let main_jpeg =
            image_processing::ensure_jpeg_response_async(main, file.content_type.clone()).await?;
        image_processing::thumbnail_from_main_jpeg_async(main_jpeg).await?
    };
    storage::write(op, &canonical_thumb, thumb_bytes.clone()).await?;
    image_generation::set_image_thumbnail_meta(
        &state.db,
        file.id,
        user_id,
        &canonical_thumb,
        thumb_bytes.len() as i64,
    )
    .await?;
    recalc_user_storage(state, user_id).await?;
    Ok(thumb_bytes)
}

/// Whether the user's starred storage directory contains a copy of this image.
pub async fn image_is_starred(
    state: &AppState,
    user_id: i64,
    image_id: i64,
) -> Result<bool, AppError> {
    image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let op = storage::operator(state)?;
    let path = image_paths::starred_image_path(user_id, image_id);
    storage::exists(op, &path).await
}

/// Copies the main JPEG into the starred directory, or removes that copy.
pub async fn set_image_starred(
    state: &AppState,
    user_id: i64,
    image_id: i64,
    starred: bool,
) -> Result<bool, AppError> {
    let file = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let op = storage::operator(state)?;
    let starred_path = image_paths::starred_image_path(user_id, image_id);
    if starred {
        let bytes = storage::read(op, &file.storage_path).await?;
        storage::write(op, &starred_path, bytes).await?;
        Ok(true)
    } else {
        storage::delete(op, &starred_path).await?;
        Ok(false)
    }
}

/// Result of a bulk file-browser cleanup pass.
pub struct CleanupFilesResult {
    pub deleted_count: u64,
    pub skipped_starred: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupFilesScope {
    Uploads,
    Generated,
    All,
}

impl CleanupFilesScope {
    pub fn parse(s: &str) -> Result<Self, AppError> {
        match s {
            "uploads" => Ok(Self::Uploads),
            "generated" => Ok(Self::Generated),
            "all" => Ok(Self::All),
            _ => Err(AppError::BadRequest(
                "scope must be uploads, generated, or all".into(),
            )),
        }
    }

    fn matches(&self, direction: &str) -> bool {
        match self {
            Self::Uploads => direction == "input",
            Self::Generated => direction == "output",
            Self::All => true,
        }
    }
}

/// Deletes storage blobs, starred copy, and the DB row for any user-owned image file.
pub(super) async fn remove_user_file_record(
    state: &AppState,
    user_id: i64,
    file: &image_generation::ImageFile,
) -> Result<(), AppError> {
    purge_stored_image(state, file).await?;
    let op = storage::operator(state)?;
    storage::delete(op, &image_paths::starred_image_path(user_id, file.id)).await?;
    image_generation::delete_image_file(&state.db, file.id, user_id).await?;
    Ok(())
}

/// Bulk delete for the file browser (uploads, generated, or all).
pub async fn cleanup_user_files(
    state: &AppState,
    user_id: i64,
    scope: CleanupFilesScope,
    keep_starred: bool,
) -> Result<CleanupFilesResult, AppError> {
    storage::operator(state)?;
    let files = image_generation::list_user_image_files(&state.db, user_id, 10_000).await?;
    let mut deleted_count = 0u64;
    let mut skipped_starred = 0u64;
    for file in files {
        if !scope.matches(&file.direction) {
            continue;
        }
        if keep_starred && image_is_starred(state, user_id, file.id).await? {
            skipped_starred += 1;
            continue;
        }
        remove_user_file_record(state, user_id, &file).await?;
        deleted_count += 1;
    }
    if deleted_count > 0 {
        recalc_user_storage(state, user_id).await?;
    }
    Ok(CleanupFilesResult {
        deleted_count,
        skipped_starred,
    })
}

/// Deletes storage blobs and the DB row for a user-owned generated output image.
pub async fn remove_user_image(
    state: &AppState,
    user_id: i64,
    image_id: i64,
) -> Result<(), AppError> {
    let file = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if file.direction != "output" {
        return Err(AppError::BadRequest(
            "only generated output images can be deleted".into(),
        ));
    }
    remove_user_file_record(state, user_id, &file).await?;
    recalc_user_storage(state, user_id).await?;
    Ok(())
}

/// Removes main image and thumbnail blobs from storage (call before deleting the DB row).
pub async fn purge_stored_image(state: &AppState, file: &image_generation::ImageFile) -> Result<(), AppError> {
    let op = storage::operator(state)?;
    storage::delete(op, &file.storage_path).await?;
    let thumb = file
        .thumbnail_storage_path
        .clone()
        .filter(|p| p != &file.storage_path)
        .unwrap_or_else(|| image_paths::thumbnail_path(file.user_id, file.id));
    storage::delete(op, &thumb).await?;
    Ok(())
}

/// A user's files plus the cached total used bytes from the users table —
/// backs the read-only file browser.
pub struct UserFileListing {
    pub files: Vec<image_generation::ImageFile>,
    pub used_bytes: i64,
}

pub async fn list_user_files(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<UserFileListing, AppError> {
    let files = image_generation::list_user_image_files(&state.db, user_id, limit).await?;
    let user = users::find_by_id(&state.db, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(UserFileListing { files, used_bytes: user.used_storage_bytes })
}
