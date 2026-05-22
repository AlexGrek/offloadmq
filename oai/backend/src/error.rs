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
