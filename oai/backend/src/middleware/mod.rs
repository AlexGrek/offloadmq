pub mod auth;

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{FromRequestParts, Request, State},
    http::request::Parts,
    middleware::Next,
    response::Response,
};

use crate::{db::users, error::AppError, state::AppState};

#[derive(Clone, Debug)]
pub struct AuthenticatedUser(pub i64);

#[derive(Clone, Debug)]
pub struct OptionalJwtUser(pub Option<i64>);

pub fn extract_jwt_token(parts: &Parts) -> Option<String> {
    parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|s| s.to_string())
        .or_else(|| {
            parts
                .headers
                .get(axum::http::header::COOKIE)
                .and_then(|h| h.to_str().ok())
                .and_then(|cookies| {
                    cookies.split(';').find_map(|c| {
                        let c = c.trim();
                        c.strip_prefix("token=")
                            .or_else(|| c.strip_prefix("jwt="))
                            .map(|s| s.to_string())
                    })
                })
        })
        .or_else(|| {
            // WebSocket clients can't set Authorization headers; support ?token= query param.
            parts.uri.query().and_then(|q| {
                q.split('&').find_map(|pair| {
                    pair.strip_prefix("token=").map(|v| v.to_string())
                })
            })
        })
}

pub async fn jwt_auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let (mut parts, body) = req.into_parts();
    let token = extract_jwt_token(&parts).ok_or(AppError::Unauthorized)?;
    let claims = state.auth.decode_token(&token).map_err(|_| AppError::Unauthorized)?;
    parts.extensions.insert(AuthenticatedUser(claims.sub));
    Ok(next.run(Request::from_parts(parts, body)).await)
}

pub async fn admin_auth_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let (mut parts, body) = req.into_parts();
    let token = extract_jwt_token(&parts).ok_or(AppError::Unauthorized)?;
    let claims = state.auth.decode_token(&token).map_err(|_| AppError::Unauthorized)?;
    let user = users::find_by_id(&state.db, claims.sub)
        .await?
        .ok_or(AppError::Unauthorized)?;
    if user.is_admin != Some(true) {
        return Err(AppError::Forbidden);
    }
    parts.extensions.insert(AuthenticatedUser(claims.sub));
    Ok(next.run(Request::from_parts(parts, body)).await)
}

pub async fn optional_jwt_middleware(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let (mut parts, body) = req.into_parts();
    let user = extract_jwt_token(&parts)
        .and_then(|token| state.auth.decode_token(&token).ok())
        .map(|claims| claims.sub);
    parts.extensions.insert(OptionalJwtUser(user));
    Ok(next.run(Request::from_parts(parts, body)).await)
}

impl<S: Send + Sync + 'static> FromRequestParts<S> for AuthenticatedUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthenticatedUser>()
            .cloned()
            .ok_or(AppError::Unauthorized)
    }
}

impl<S: Send + Sync + 'static> FromRequestParts<S> for OptionalJwtUser {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(parts
            .extensions
            .get::<OptionalJwtUser>()
            .cloned()
            .unwrap_or(OptionalJwtUser(None)))
    }
}
