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
    let hash = state.auth.hash_password(req.password).await?;
    let id = state.next_id();
    let user = users::create(&state.db, id, &req.login, Some(hash), None).await?;
    let token = state.auth.create_token(user.id)?;
    Ok(Json(AuthResponse { token, user_id: user.id }))
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    let found = users::find_by_login(&state.db, &req.login)
        .await?
        .and_then(|u| u.password_hash.clone().map(|h| (u, h)));
    let Some((user, hash)) = found else {
        // Unknown login or passwordless account: do the same bcrypt work as the
        // real path so response time doesn't reveal which logins exist.
        state.auth.verify_dummy(req.password).await;
        return Err(AppError::Unauthorized);
    };
    if !state.auth.verify_password(req.password, hash).await? {
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

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Serialize)]
pub struct ChangePasswordResponse {
    pub ok: bool,
}

pub async fn change_password(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<ChangePasswordResponse>, AppError> {
    if req.new_password.len() < 6 {
        return Err(AppError::BadRequest(
            "New password must be at least 6 characters".into(),
        ));
    }
    let user = users::find_by_id(&state.db, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let hash = user
        .password_hash
        .clone()
        .ok_or(AppError::BadRequest(
            "This account has no password set; sign in with your linked provider".into(),
        ))?;
    if !state.auth.verify_password(req.current_password, hash).await? {
        return Err(AppError::Unauthorized);
    }
    let new_hash = state.auth.hash_password(req.new_password).await?;
    users::update_password_hash(&state.db, user_id, new_hash).await?;
    // A new password ends every connected MCP client (OAuth grant) as well.
    crate::db::oauth::revoke_user_grants(&state.db, user_id).await?;
    Ok(Json(ChangePasswordResponse { ok: true }))
}
