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

/// Marker inserted into request extensions when a valid management token was
/// supplied via the `X-MGMT-API-KEY` header on a client API route.
/// Handlers can check for this to bypass per-key capability / ownership checks.
#[derive(Clone)]
pub struct MgmtOverride;

/// Optional extractor: `Some(MgmtOverride)` when the mgmt header was used,
/// `None` for regular client-key requests.  Never rejects.
pub struct OptionalMgmtOverride(pub Option<MgmtOverride>);

impl OptionalMgmtOverride {
    pub fn is_active(&self) -> bool {
        self.0.is_some()
    }
}

impl<S: Send + Sync + 'static> FromRequestParts<S> for OptionalMgmtOverride {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(OptionalMgmtOverride(parts.extensions.get::<MgmtOverride>().cloned()))
    }
}

/// Carries the validated client API key extracted from the `X-API-Key` header.
/// This is the same key used for all other client API endpoints — no separate
/// key type exists.  Inserted by [`apikey_header_auth_middleware_storage`].
#[derive(Clone)]
pub struct StorageApiKey(pub String);

impl<S: Send + Sync + 'static> FromRequestParts<S> for StorageApiKey {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<StorageApiKey>()
            .cloned()
            .ok_or_else(|| AppError::Authorization("Missing X-API-Key header".to_string()))
    }
}

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

pub async fn token_auth_middleware_mgmt(
    State(app_state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let (parts, body) = req.into_parts();

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

    if token == app_state.config.management_token {
        let req = Request::from_parts(parts, body);
        Ok(next.run(req).await)
    } else {
        Err(AppError::Authorization("Unauthorized".to_string()))
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
    let (mut parts, body) = req.into_parts();

    // Check for management override header first
    let mgmt_key = parts
        .headers
        .get("X-MGMT-API-KEY")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(ref key) = mgmt_key {
        if *key == app_state.config.management_token {
            parts.extensions.insert(MgmtOverride);
            let req = Request::from_parts(parts, body);
            return Ok(next.run(req).await);
        }
        return Err(AppError::Authorization(
            "Invalid X-MGMT-API-KEY".to_string(),
        ));
    }

    // Read the body into bytes
    let body_bytes = axum::body::to_bytes(body, app_state.config.max_request_body_bytes)
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?;

    // Attempt to parse the API key from the JSON payload
    let api_key_payload: ApiKeyPayload = serde_json::from_slice(&body_bytes)
        .map_err(|e| AppError::Authorization(format!("Failed to parse JSON body: {}", e)))?;

    if !app_state
        .storage
        .client_keys
        .is_key_real_not_revoked(&api_key_payload.api_key)
    {
        return Err(AppError::Authorization(format!(
            "Unauthorized: {api_key_payload:?}"
        )));
    }
    let new_body = Body::from(body_bytes);
    let req = Request::from_parts(parts, new_body);
    Ok(next.run(req).await)
}

/// Auth middleware for the Storage API surface.
/// Reads the client API key from the `X-API-Key` header and validates it
/// against the same key store used by all other client API endpoints.
/// GET / DELETE / multipart requests can't carry a JSON body, so the header
/// is the natural transport here — the key value is identical to what you'd
/// pass as `api_key` in a JSON body on other `/api/*` routes.
pub async fn apikey_header_auth_middleware_storage(
    State(app_state): State<Arc<AppState>>,
    mut req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let api_key = req
        .headers()
        .get("X-API-Key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            AppError::Authorization(
                "Missing X-API-Key header (use your regular client API key)".to_string(),
            )
        })?;

    if !app_state
        .storage
        .client_keys
        .is_key_real_not_revoked(&api_key)
    {
        return Err(AppError::Authorization("Invalid client API key".to_string()));
    }

    req.extensions_mut().insert(StorageApiKey(api_key));
    Ok(next.run(req).await)
}
