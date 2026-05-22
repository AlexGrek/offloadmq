use std::sync::Arc;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::{db::{app_settings, users}, error::AppError, middleware::AuthenticatedUser, state::AppState};

#[derive(Deserialize)]
pub struct CheckConnectionRequest {
    pub offloadmq_url: String,
    pub client_api_token: Option<String>,
    pub management_api_token: Option<String>,
}

#[derive(Serialize)]
pub struct TokenCheckResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct CheckConnectionResponse {
    pub client_token: Option<TokenCheckResult>,
    pub management_token: Option<TokenCheckResult>,
}

#[derive(Serialize, Deserialize)]
pub struct SettingsResponse {
    pub offloadmq_url: String,
    pub client_api_token: Option<String>,
    pub management_api_token: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateSettingsRequest {
    pub offloadmq_url: String,
    pub client_api_token: Option<String>,
    pub management_api_token: Option<String>,
}

#[derive(Serialize)]
pub struct AmIAdminResponse {
    pub is_admin: bool,
}

pub async fn get_settings(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<SettingsResponse>, AppError> {
    let s = app_settings::get(&state.db).await?;
    Ok(Json(SettingsResponse {
        offloadmq_url: s.offloadmq_url,
        client_api_token: s.client_api_token,
        management_api_token: s.management_api_token,
    }))
}

pub async fn update_settings(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Json(req): Json<UpdateSettingsRequest>,
) -> Result<Json<SettingsResponse>, AppError> {
    let s = app_settings::update(
        &state.db,
        req.offloadmq_url,
        req.client_api_token,
        req.management_api_token,
    )
    .await?;
    Ok(Json(SettingsResponse {
        offloadmq_url: s.offloadmq_url,
        client_api_token: s.client_api_token,
        management_api_token: s.management_api_token,
    }))
}

pub async fn am_i_admin(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<AmIAdminResponse>, AppError> {
    let user = users::find_by_id(&state.db, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(AmIAdminResponse { is_admin: user.is_admin == Some(true) }))
}

pub async fn check_connection(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Json(req): Json<CheckConnectionRequest>,
) -> Result<Json<CheckConnectionResponse>, AppError> {
    let base = req.offloadmq_url.trim_end_matches('/');

    let client_result = match req.client_api_token {
        None => None,
        Some(token) if token.is_empty() => None,
        Some(token) => {
            let url = format!("{base}/api/capabilities/online");
            let result = state
                .http
                .get(&url)
                .header("X-API-Key", &token)
                .send()
                .await;
            Some(match result {
                Ok(resp) if resp.status().is_success() => TokenCheckResult { ok: true, error: None },
                Ok(resp) if resp.status() == 401 || resp.status() == 403 => {
                    TokenCheckResult { ok: false, error: Some("Invalid client token".to_string()) }
                }
                Ok(resp) => TokenCheckResult {
                    ok: false,
                    error: Some(format!("Unexpected status {}", resp.status())),
                },
                Err(e) => TokenCheckResult { ok: false, error: Some(e.to_string()) },
            })
        }
    };

    let management_result = match req.management_api_token {
        None => None,
        Some(token) if token.is_empty() => None,
        Some(token) => {
            let url = format!("{base}/management/version");
            let result = state
                .http
                .get(&url)
                .header("Authorization", format!("Bearer {token}"))
                .send()
                .await;
            Some(match result {
                Ok(resp) if resp.status().is_success() => TokenCheckResult { ok: true, error: None },
                Ok(resp) if resp.status() == 401 || resp.status() == 403 => {
                    TokenCheckResult { ok: false, error: Some("Invalid management token".to_string()) }
                }
                Ok(resp) => TokenCheckResult {
                    ok: false,
                    error: Some(format!("Unexpected status {}", resp.status())),
                },
                Err(e) => TokenCheckResult { ok: false, error: Some(e.to_string()) },
            })
        }
    };

    Ok(Json(CheckConnectionResponse {
        client_token: client_result,
        management_token: management_result,
    }))
}
