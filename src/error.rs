use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sled::Error),

    #[error("Internal error: {0}")]
    Internal(#[from] anyhow::Error),

    #[error("Serialization error: {0}")]
    Serialization(String),

    #[error("Authentication failed: {0}")]
    Authentication(String),

    #[error("Authorization failed: {0}")]
    Authorization(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("JWT error: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Parse error: {0}")]
    Parse(String),

    #[error("Bcrypt error: {0}")]
    BcryptError(#[from] bcrypt::BcryptError),
}

impl AppError {
    /// Get the HTTP status code for this error
    pub fn status_code(&self) -> StatusCode {
        match self {
            AppError::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::Serialization(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::Authentication(_) => StatusCode::UNAUTHORIZED,
            AppError::Authorization(_) => StatusCode::FORBIDDEN,
            AppError::Validation(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Jwt(_) => StatusCode::UNAUTHORIZED,
            AppError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
            AppError::Parse(_) => StatusCode::BAD_REQUEST,
            AppError::BcryptError(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// Get error type as string for JSON responses
    pub fn error_type(&self) -> &'static str {
        match self {
            AppError::Database(_) => "database_error",
            AppError::Internal(_) => "internal_error",
            AppError::Serialization(_) => "serialization_error",
            AppError::Authentication(_) => "authentication_error",
            AppError::Authorization(_) => "authorization_error",
            AppError::Validation(_) => "validation_error",
            AppError::NotFound(_) => "not_found",
            AppError::Conflict(_) => "conflict",
            AppError::BadRequest(_) => "bad_request",
            AppError::Jwt(_) => "jwt_error",
            AppError::Io(_) => "io_error",
            AppError::Parse(_) => "parse_error",
            AppError::BcryptError(_) => "bcrypt_error",
        }
    }

    /// Check if this error should be logged
    pub fn should_log(&self) -> bool {
        match self {
            // Don't log client errors (4xx)
            AppError::Authentication(_) 
            | AppError::Authorization(_) 
            | AppError::Validation(_) 
            | AppError::NotFound(_) 
            | AppError::BadRequest(_) 
            | AppError::Jwt(_) 
            | AppError::Parse(_) => false,
            
            // Log server errors (5xx) and conflicts
            AppError::Database(_) 
            | AppError::Internal(_) 
            | AppError::Serialization(_) 
            | AppError::Io(_) 
            | AppError::Conflict(_)
            | AppError::BcryptError(_) => true,
        }
    }
}

// Implement IntoResponse for Axum
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        
        // Log server errors
        if self.should_log() {
            tracing::error!("AppError: {} (status: {})", self, status);
        } else {
            tracing::debug!("AppError: {} (status: {})", self, status);
        }

        let body = json!({
            "error": {
                "type": self.error_type(),
                "message": self.to_string(),
                "status": status.as_u16()
            }
        });

        (status, Json(body)).into_response()
    }
}

// Convenience constructors
impl AppError {
    pub fn authentication<T: std::fmt::Display>(msg: T) -> Self {
        Self::Authentication(msg.to_string())
    }

    pub fn authorization<T: std::fmt::Display>(msg: T) -> Self {
        Self::Authorization(msg.to_string())
    }

    pub fn validation<T: std::fmt::Display>(msg: T) -> Self {
        Self::Validation(msg.to_string())
    }

    pub fn not_found<T: std::fmt::Display>(msg: T) -> Self {
        Self::NotFound(msg.to_string())
    }

    pub fn conflict<T: std::fmt::Display>(msg: T) -> Self {
        Self::Conflict(msg.to_string())
    }

    pub fn bad_request<T: std::fmt::Display>(msg: T) -> Self {
        Self::BadRequest(msg.to_string())
    }

    pub fn serialization<T: std::fmt::Display>(msg: T) -> Self {
        Self::Serialization(msg.to_string())
    }

    pub fn parse<T: std::fmt::Display>(msg: T) -> Self {
        Self::Parse(msg.to_string())
    }
}

// Additional From implementations for common error types
impl From<rmp_serde::encode::Error> for AppError {
    fn from(err: rmp_serde::encode::Error) -> Self {
        Self::Serialization(err.to_string())
    }
}

impl From<rmp_serde::decode::Error> for AppError {
    fn from(err: rmp_serde::decode::Error) -> Self {
        Self::Serialization(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::Serialization(err.to_string())
    }
}

impl From<std::string::FromUtf8Error> for AppError {
    fn from(err: std::string::FromUtf8Error) -> Self {
        Self::Parse(format!("UTF-8 conversion error: {}", err))
    }
}

impl From<std::num::ParseIntError> for AppError {
    fn from(err: std::num::ParseIntError) -> Self {
        Self::Parse(format!("Integer parse error: {}", err))
    }
}

// Type alias for Results
pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_status_codes() {
        assert_eq!(AppError::authentication("test").status_code(), StatusCode::UNAUTHORIZED);
        assert_eq!(AppError::authorization("test").status_code(), StatusCode::FORBIDDEN);
        assert_eq!(AppError::validation("test").status_code(), StatusCode::BAD_REQUEST);
        assert_eq!(AppError::not_found("test").status_code(), StatusCode::NOT_FOUND);
        assert_eq!(AppError::conflict("test").status_code(), StatusCode::CONFLICT);
    }

    #[test]
    fn test_error_types() {
        assert_eq!(AppError::authentication("test").error_type(), "authentication_error");
        assert_eq!(AppError::Database(sled::Error::Unsupported("test".to_string())).error_type(), "database_error");
        assert_eq!(AppError::BcryptError(bcrypt::BcryptError::InvalidHash("test".to_string())).error_type(), "bcrypt_error");
    }

    #[test]
    fn test_should_log() {
        assert!(!AppError::authentication("test").should_log());
        assert!(!AppError::not_found("test").should_log());
        assert!(AppError::Database(sled::Error::Unsupported("test".to_string())).should_log());
        assert!(AppError::Internal(anyhow::anyhow!("test")).should_log());
    }

    #[test]
    fn test_conversions() {
        let db_error = sled::Error::Unsupported("test".to_string());
        let app_error: AppError = db_error.into();
        assert!(matches!(app_error, AppError::Database(_)));

        let anyhow_error = anyhow::anyhow!("test error");
        let app_error: AppError = anyhow_error.into();
        assert!(matches!(app_error, AppError::Internal(_)));
    }
}
