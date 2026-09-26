use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Unauthorized")]
    Unauthorized,
    #[error("Forbidden")]
    Forbidden,
    #[error("Not found")]
    NotFound,
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Database error")]
    Database(#[from] sea_orm::DbErr),
    #[error("JWT error")]
    Jwt(#[from] jsonwebtoken::errors::Error),
    #[error("Bcrypt error")]
    Bcrypt(#[from] bcrypt::BcryptError),
    #[error("Internal: {0}")]
    Internal(String),
    #[error("External service error: {0}")]
    ExternalService(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "Forbidden".to_string()),
            AppError::NotFound => (StatusCode::NOT_FOUND, "Not found".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Database(e) => {
                tracing::error!("db error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
            }
            AppError::Jwt(_) => (StatusCode::UNAUTHORIZED, "Unauthorized".to_string()),
            AppError::Bcrypt(e) => {
                tracing::error!("bcrypt error: {e}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
            }
            AppError::Internal(m) => {
                tracing::error!("internal error: {m}");
                (StatusCode::INTERNAL_SERVER_ERROR, m.clone())
            }
            AppError::ExternalService(m) => {
                tracing::warn!("external service error: {m}");
                (StatusCode::BAD_GATEWAY, m.clone())
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

/// For best-effort operations whose failure must not fail the caller (cleanup,
/// audit-log writes, cancelling an upstream task) but should never vanish silently
/// either — a bare `let _ = op().await;` discards the only evidence something broke.
pub trait ResultExt<T> {
    /// On `Err`, logs `"{what} failed: {error:?}"` at warn level; always discards the
    /// error and returns the `Ok` value, if any.
    ///
    /// Uses `Debug` on purpose: `AppError::Database`'s `Display` is just "Database
    /// error" and would drop the underlying cause.
    fn log_warn(self, what: &str) -> Option<T>;
}

impl<T, E: std::fmt::Debug> ResultExt<T> for Result<T, E> {
    fn log_warn(self, what: &str) -> Option<T> {
        match self {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::warn!("{what} failed: {e:?}");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_warn_passes_ok_through_and_swallows_err() {
        assert_eq!(Ok::<_, AppError>(7).log_warn("x"), Some(7));
        assert_eq!(Err::<i32, _>(AppError::NotFound).log_warn("x"), None);
        assert_eq!(Err::<i32, _>("plain string error").log_warn("x"), None);
    }
}
