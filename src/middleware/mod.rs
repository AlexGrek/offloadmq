use std::sync::Arc;

use axum::{
    body::Body,
    extract::{FromRequestParts, Request, State},
    http::request::Parts,
    middleware::Next,
    response::Response,
};

pub mod auth;

use crate::{error::AppError, models::Agent, state::AppState};

// Custom extractor to get the authenticated user email from extensions
pub struct AuthenticatedAgentId(pub String);

pub struct AuthenticatedAgent(pub Agent);

// Removed #[async_trait]
impl<S> FromRequestParts<S> for AuthenticatedAgent
where
    S: Send + Sync + 'static, // 'static bound is often needed for extractors in axum 0.8
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        let user = parts
            .extensions
            .get::<Agent>()
            .cloned()
            .ok_or(AppError::Authentication("agent type".to_string()))?;
        Ok(AuthenticatedAgent(user))
    }
}

impl<S> FromRequestParts<S> for AuthenticatedAgentId
where
    S: Send + Sync + 'static, // 'static bound is often needed for extractors in axum 0.8
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let user_email = parts
            .extensions
            .get::<String>()
            .cloned()
            .ok_or(AppError::Authentication("user email".to_string()))?;

        Ok(AuthenticatedAgentId(user_email))
    }
}

pub async fn jwt_auth_middleware_agent(
    State(app_state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let (mut parts, body) = req.into_parts();

    let path = parts.uri.path();

    if path == "/register" || path == "/login" {
        let req = Request::from_parts(parts, body);
        return Ok(next.run(req).await);
    }

    let auth_header = parts
        .headers
        .get("Authorization")
        .and_then(|header| header.to_str().ok());

    let token =
        auth_header.and_then(|header| header.strip_prefix("Bearer ").map(|s| s.to_string()));

    let token = token.ok_or(AppError::Authorization("Unauthorized".to_string()))?;

    match app_state.auth.decode_token(&token) {
        Ok(claims) => {
            parts.extensions.insert(claims.sub.clone());
            // insert actual user
            let user = app_state.storage.get_agent(&claims.sub);

            match user {
                Some(u) => {
                    parts.extensions.insert(u);
                    ()
                }
                _ => return Err(AppError::Authorization("Agent not found".to_string())),
            }

            let req = Request::from_parts(parts, body);
            Ok(next.run(req).await)
        }
        Err(e) => {
            log::warn!("JWT validation failed: {}", e);
            Err(AppError::Authorization("JWT token invalid".to_string()))
        }
    }
}
