use axum::Json;
use serde::Serialize;

use crate::version::build_version;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
}

pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: build_version(),
    })
}

#[derive(Serialize)]
pub struct VersionResponse {
    pub version: &'static str,
}

/// Public endpoint the SPA polls to detect new deployments and prompt a reload.
pub async fn version() -> Json<VersionResponse> {
    Json(VersionResponse {
        version: build_version(),
    })
}
