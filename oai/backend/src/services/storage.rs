//! Thin helpers over the OpenDAL operator held in `AppState`.
//! Centralizes the "is storage enabled?" check so handlers never touch
//! `state.storage` directly or unwrap it.

use opendal::Operator;

use crate::{error::AppError, state::AppState};

/// Returns the configured storage operator, or a `BadRequest` if the backend
/// is disabled. Replaces the previous `ensure_storage_enabled` + `.expect()`
/// pattern with a single fallible accessor.
pub fn operator(state: &AppState) -> Result<&Operator, AppError> {
    state.storage.as_ref().ok_or_else(|| {
        AppError::BadRequest(
            "storage backend is disabled; set STORAGE_BACKEND=fs (or local) for dev, s3 for prod"
                .into(),
        )
    })
}

pub async fn read(op: &Operator, path: &str) -> Result<Vec<u8>, AppError> {
    op.read(path)
        .await
        .map(|b| b.to_vec())
        .map_err(|e| AppError::Internal(format!("storage read failed: {e}")))
}

pub async fn write(op: &Operator, path: &str, bytes: Vec<u8>) -> Result<(), AppError> {
    op.write(path, bytes)
        .await
        .map(|_| ())
        .map_err(|e| AppError::Internal(format!("storage write failed: {e}")))
}

/// Returns whether a blob exists at `path`.
pub async fn exists(op: &Operator, path: &str) -> Result<bool, AppError> {
    op.exists(path)
        .await
        .map_err(|e| AppError::Internal(format!("storage exists check failed: {e}")))
}

/// Deletes a blob if present; missing paths are ignored.
pub async fn delete(op: &Operator, path: &str) -> Result<(), AppError> {
    match op.delete(path).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == opendal::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Internal(format!("storage delete failed: {e}"))),
    }
}
