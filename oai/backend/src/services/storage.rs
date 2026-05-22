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
        AppError::BadRequest("storage backend is disabled; set STORAGE_BACKEND".into())
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
