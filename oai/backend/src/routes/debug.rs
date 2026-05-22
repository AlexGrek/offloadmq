use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    services::debug_offload::{self, ExtraOffloadJob},
    state::AppState,
};

#[derive(Debug, Deserialize)]
pub struct ExtraJobInput {
    pub cap: String,
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OffloadStatusRequest {
    #[serde(default)]
    pub extra: Vec<ExtraJobInput>,
}

pub async fn offload_status(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<OffloadStatusRequest>,
) -> Result<impl IntoResponse, AppError> {
    let extra: Vec<ExtraOffloadJob> = req
        .extra
        .into_iter()
        .map(|j| {
            let key = j
                .key
                .unwrap_or_else(|| format!("{}:{}:{}", j.source.as_deref().unwrap_or("extra"), j.cap, j.id));
            ExtraOffloadJob {
                key,
                source: j.source.unwrap_or_else(|| "client".to_string()),
                label: j.label,
                cap: j.cap,
                id: j.id,
            }
        })
        .collect();

    let yaml = debug_offload::build_offload_status_yaml(&state, user_id, extra).await?;
    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/yaml; charset=utf-8")],
        yaml,
    ))
}
