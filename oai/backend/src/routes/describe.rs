use std::sync::Arc;

use axum::{
    extract::{Multipart, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    offload::TaskId,
    services::{describe, offload_factory},
    state::AppState,
};

#[derive(Serialize)]
pub struct CapabilitiesResponse {
    pub capabilities: Vec<describe::DescribeCapability>,
}

pub async fn list_capabilities(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
) -> Result<Json<CapabilitiesResponse>, AppError> {
    let capabilities = describe::list_vision_capabilities(&state).await?;
    Ok(Json(CapabilitiesResponse { capabilities }))
}

#[derive(Serialize)]
pub struct SubmitResponse {
    pub cap: String,
    pub id: String,
}

pub async fn submit(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    mut multipart: Multipart,
) -> Result<Json<SubmitResponse>, AppError> {
    let mut capability: Option<String> = None;
    let mut prompt: Option<String> = None;
    let mut image_bytes: Option<Vec<u8>> = None;
    let mut filename = "image.jpg".to_string();
    let mut content_type = "image/jpeg".to_string();

    while let Some(field) =
        multipart.next_field().await.map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        match field.name() {
            Some("capability") => {
                capability =
                    Some(field.text().await.map_err(|e| AppError::BadRequest(e.to_string()))?);
            }
            Some("prompt") => {
                prompt =
                    Some(field.text().await.map_err(|e| AppError::BadRequest(e.to_string()))?);
            }
            Some("image") => {
                if let Some(fname) = field.file_name() {
                    filename = fname.to_string();
                }
                if let Some(ct) = field.content_type() {
                    content_type = ct.to_string();
                }
                image_bytes = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| AppError::BadRequest(e.to_string()))?
                        .to_vec(),
                );
            }
            _ => {}
        }
    }

    let capability = capability
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("missing capability field".into()))?;
    let prompt = prompt
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("missing prompt field".into()))?;
    let image_bytes =
        image_bytes.ok_or_else(|| AppError::BadRequest("missing image field".into()))?;

    let (cap, id) =
        describe::submit_describe_task(&state, &capability, &prompt, image_bytes, &filename, &content_type)
            .await?;

    Ok(Json(SubmitResponse { cap, id }))
}

#[derive(Deserialize)]
pub struct PollRequest {
    pub cap: String,
    pub id: String,
}

pub async fn poll(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(_): AuthenticatedUser,
    Json(req): Json<PollRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let client = offload_factory::chat_client(&state).await?;
    let body = client.poll_task_raw(&TaskId { cap: req.cap, id: req.id }).await?;
    Ok(Json(body))
}
