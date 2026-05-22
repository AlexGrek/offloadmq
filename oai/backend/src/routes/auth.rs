use std::sync::Arc;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::{db::users, error::AppError, middleware::AuthenticatedUser, state::AppState};

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub login: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub login: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user_id: i64,
}

pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    if req.login.trim().is_empty() || req.password.len() < 6 {
        return Err(AppError::BadRequest(
            "Login must not be empty and password must be at least 6 characters".into(),
        ));
    }
    if users::find_by_login(&state.db, &req.login).await?.is_some() {
        return Err(AppError::BadRequest("Login already taken".into()));
    }
    let hash = state.auth.hash_password(&req.password)?;
    let id = state.next_id();
    let user = users::create(&state.db, id, &req.login, Some(hash), None).await?;
    let token = state.auth.create_token(user.id)?;
    Ok(Json(AuthResponse { token, user_id: user.id }))
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let user = users::find_by_login(&state.db, &req.login)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let hash = user.password_hash.as_deref().ok_or(AppError::Unauthorized)?;
    if !state.auth.verify_password(&req.password, hash)? {
        return Err(AppError::Unauthorized);
    }
    let token = state.auth.create_token(user.id)?;
    Ok(Json(AuthResponse { token, user_id: user.id }))
}

pub async fn me(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<users::User>, AppError> {
    users::find_by_id(&state.db, user_id)
        .await?
        .map(Json)
        .ok_or(AppError::NotFound)
}
