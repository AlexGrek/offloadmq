use std::sync::Arc;

use axum::{
    body::Body,
    extract::{FromRequestParts, Request, State},
    http::request::Parts,
    middleware::Next,
    response::Response,
};
use serde::Deserialize;

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

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ApiKeyPayload {
    api_key: String,
}

pub async fn apikey_auth_middleware_user(
    State(app_state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let (parts, body) = req.into_parts();

    // Read the body into bytes
    let body_bytes = axum::body::to_bytes(body, 500000)
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;

    // Attempt to parse the API key from the JSON payload
    let api_key_payload: ApiKeyPayload = serde_json::from_slice(&body_bytes)
        .map_err(|e| AppError::Authorization(format!("Failed to parse JSON body: {}", e)))?;

    if !app_state
        .config
        .client_api_keys
        .contains(&api_key_payload.api_key)
    {
        return Err(AppError::Authorization(format!(
            "Unauthorized: {api_key_payload:?}"
        )));
    }
    let new_body = Body::from(body_bytes);
    let req = Request::from_parts(parts, new_body);
    Ok(next.run(req).await)
}
