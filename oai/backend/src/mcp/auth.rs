//! Bearer authentication for `/mcp`.
//!
//! Accepts an OAuth access token issued by `services::oauth` (what Claude's connector
//! uses), or — for scripted clients and local testing — a regular OAI user JWT, the
//! same token the `oai` CLI stores. Only the `Authorization` header is read: no cookie
//! or `?token=`, so a browser can never be tricked into calling `/mcp` with ambient
//! credentials. Failures answer 401 with the RFC 9728 `resource_metadata` pointer that
//! starts the OAuth flow in MCP clients.

use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde_json::json;

use crate::{middleware::AuthenticatedUser, services::oauth, state::AppState};

pub async fn mcp_auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let base = oauth::public_base_url(req.headers());
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| {
            h.strip_prefix("Bearer ")
                .or_else(|| h.strip_prefix("bearer "))
        })
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let Some(token) = token else {
        return unauthorized(&base, None);
    };

    let user_id = match oauth::authenticate_access_token(&state, &token).await {
        Ok(Some(id)) => Some(id),
        Ok(None) => state.auth.decode_token(&token).ok().map(|c| c.sub),
        Err(e) => {
            tracing::error!("mcp token lookup failed: {e:?}");
            return (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response();
        }
    };
    let Some(user_id) = user_id else {
        return unauthorized(&base, Some("invalid_token"));
    };

    let (mut parts, body) = req.into_parts();
    parts.extensions.insert(AuthenticatedUser(user_id));
    next.run(Request::from_parts(parts, body)).await
}

fn unauthorized(base: &str, error: Option<&str>) -> Response {
    let mut challenge = format!(
        "Bearer resource_metadata=\"{}\", scope=\"{}\"",
        oauth::resource_metadata_url(base),
        oauth::SCOPE
    );
    if let Some(e) = error {
        challenge.push_str(&format!(", error=\"{e}\""));
    }
    let mut resp = (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": error.unwrap_or("unauthorized"), "error_description": "OAuth bearer token required" })),
    )
        .into_response();
    if let Ok(v) = HeaderValue::from_str(&challenge) {
        resp.headers_mut().insert(header::WWW_AUTHENTICATE, v);
    }
    resp
}
