//! Signed, expiring links to a user's full-resolution images, so an MCP client (e.g.
//! the Claude mobile app) can open or save a generated image without a user JWT ever
//! appearing in the conversation. `GET /mcp/files/{image_id}?u=&exp=&sig=` — the HMAC
//! (see `Auth::sign_link`) covers the image id, owner and expiry.

use std::sync::{Arc, OnceLock};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;

use crate::{error::AppError, services::image_jobs, state::AppState};

use super::ToolContext;

const DEFAULT_TTL_HOURS: i64 = 24;

fn link_ttl() -> chrono::Duration {
    static HOURS: OnceLock<i64> = OnceLock::new();
    let hours = *HOURS.get_or_init(|| {
        std::env::var("MCP_FILE_LINK_TTL_HOURS")
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|h| *h > 0)
            .unwrap_or(DEFAULT_TTL_HOURS)
    });
    chrono::Duration::hours(hours)
}

fn link_message(image_id: i64, user_id: i64, exp: i64) -> String {
    format!("mcp-file:{image_id}.{user_id}.{exp}")
}

/// `{base}/mcp/files/{id}?u=…&exp=…&sig=…`, valid for `MCP_FILE_LINK_TTL_HOURS`.
pub fn signed_file_url(ctx: &ToolContext, image_id: i64) -> String {
    let exp = (chrono::Utc::now() + link_ttl()).timestamp();
    let sig = ctx
        .state
        .auth
        .sign_link(&link_message(image_id, ctx.user_id, exp));
    format!(
        "{}/mcp/files/{image_id}?u={}&exp={exp}&sig={sig}",
        ctx.base, ctx.user_id
    )
}

#[derive(Deserialize)]
pub struct LinkQuery {
    u: i64,
    exp: i64,
    sig: String,
}

/// `GET /mcp/files/{image_id}` — public; authorized by the signature alone.
pub async fn get_file(
    State(state): State<Arc<AppState>>,
    Path(image_id): Path<i64>,
    Query(q): Query<LinkQuery>,
) -> Result<Response, AppError> {
    if q.exp < chrono::Utc::now().timestamp() {
        return Err(AppError::Forbidden);
    }
    if !state
        .auth
        .verify_link(&link_message(image_id, q.u, q.exp), &q.sig)
    {
        return Err(AppError::Forbidden);
    }
    let (bytes, content_type) = image_jobs::image_bytes(&state, q.u, image_id).await?;
    let mut resp = (StatusCode::OK, bytes).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("image/jpeg")),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    Ok(resp)
}
