//! OpenRouter-style error envelope: `{"error": {"code": <http>, "message": ...}}`.
//!
//! The OpenAI / OpenRouter SDKs read `error.message` (and the HTTP status), so
//! `/api/v1` answers in this shape instead of the regular `AppError` JSON.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::error::AppError;

#[derive(Debug)]
pub struct OrError {
    pub status: StatusCode,
    pub message: String,
    pub metadata: Option<Value>,
}

impl OrError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            metadata: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    pub fn no_endpoints(model: &str) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            format!("No endpoints found for {model}."),
        )
    }

    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// The `error` object, also used for mid-stream SSE errors.
    pub fn body(&self) -> Value {
        let mut err = json!({
            "code": self.status.as_u16(),
            "message": self.message,
        });
        if let Some(metadata) = &self.metadata {
            err["metadata"] = metadata.clone();
        }
        err
    }
}

impl IntoResponse for OrError {
    fn into_response(self) -> Response {
        if self.status.is_server_error() {
            log::warn!("/api/v1 error {}: {}", self.status, self.message);
        }
        (self.status, Json(json!({ "error": self.body() }))).into_response()
    }
}

impl From<AppError> for OrError {
    fn from(e: AppError) -> Self {
        let message = match &e {
            AppError::Authentication(m)
            | AppError::Authorization(m)
            | AppError::Validation(m)
            | AppError::NotFound(m)
            | AppError::Conflict(m)
            | AppError::BadRequest(m)
            | AppError::SchedulingImpossible(m)
            | AppError::ClientClosedRequest(m) => m.clone(),
            other => other.to_string(),
        };
        Self::new(e.status_code(), message)
    }
}

pub type OrResult<T> = Result<T, OrError>;
