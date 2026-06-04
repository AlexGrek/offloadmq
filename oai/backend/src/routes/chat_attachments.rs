use std::sync::Arc;

use axum::{
    extract::{Multipart, Path, State},
    http::{HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    error::AppError,
    middleware::AuthenticatedUser,
    services::chat_attachments as service,
    state::AppState,
};

#[derive(Serialize)]
pub struct AttachmentResponse {
    pub attachment: service::AttachmentDto,
}

#[derive(Serialize)]
pub struct DocumentsResponse {
    pub documents: Vec<service::AttachmentDto>,
}

#[derive(Deserialize)]
pub struct CreateImageAttachmentRequest {
    pub image_id: String,
}

#[derive(Deserialize)]
pub struct ReferenceDocumentRequest {
    pub attachment_id: String,
}

fn parse_id(value: &str, field: &str) -> Result<i64, AppError> {
    value
        .parse::<i64>()
        .map_err(|_| AppError::BadRequest(format!("invalid {field}")))
}

/// `POST /api/chat/attachments/upload` — multipart `file`; stores a document.
pub async fn upload_document(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let (filename, bytes, content_type) = read_upload(multipart).await?;
    let att = service::upload_document(&state, user_id, filename, bytes, content_type).await?;
    Ok((
        StatusCode::CREATED,
        Json(AttachmentResponse { attachment: service::to_dto(&att) }),
    ))
}

/// `POST /api/chat/attachments/image` — references an existing `image_files` row
/// (a freshly uploaded image, or an uploaded/AI-generated image from Files).
pub async fn create_image_attachment(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<CreateImageAttachmentRequest>,
) -> Result<impl IntoResponse, AppError> {
    let image_id = parse_id(&req.image_id, "image_id")?;
    let att = service::create_image_attachment(&state, user_id, image_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(AttachmentResponse { attachment: service::to_dto(&att) }),
    ))
}

/// `POST /api/chat/attachments/reference` — re-reference a prior document.
pub async fn reference_document(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Json(req): Json<ReferenceDocumentRequest>,
) -> Result<impl IntoResponse, AppError> {
    let source_id = parse_id(&req.attachment_id, "attachment_id")?;
    let att = service::reference_document(&state, user_id, source_id).await?;
    Ok((
        StatusCode::CREATED,
        Json(AttachmentResponse { attachment: service::to_dto(&att) }),
    ))
}

/// `GET /api/chat/attachments/documents` — prior uploaded documents (picker).
pub async fn list_documents(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
) -> Result<Json<DocumentsResponse>, AppError> {
    let docs = service::list_documents(&state, user_id).await?;
    Ok(Json(DocumentsResponse {
        documents: docs.iter().map(service::to_dto).collect(),
    }))
}

/// `GET /api/chat/attachments/{id}/download` — raw document bytes.
pub async fn download_document(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    Path(attachment_id_str): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let attachment_id = parse_id(&attachment_id_str, "attachment_id")?;
    let (bytes, content_type, filename) =
        service::document_bytes(&state, user_id, attachment_id).await?;
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    if let Ok(disp) = HeaderValue::from_str(&format!("inline; filename=\"{}\"", sanitize(&filename)))
    {
        headers.insert(axum::http::header::CONTENT_DISPOSITION, disp);
    }
    Ok((StatusCode::OK, headers, bytes))
}

/// Strips characters that would break a `Content-Disposition` filename.
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c == '"' || c == '\\' || c.is_control() { '_' } else { c })
        .collect()
}

async fn read_upload(mut multipart: Multipart) -> Result<(String, Vec<u8>, String), AppError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("multipart read error: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field
            .file_name()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "upload.txt".into());
        let content_type = field
            .content_type()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| "application/octet-stream".into());
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("multipart field read error: {e}")))?;
        return Ok((filename, bytes.to_vec(), content_type));
    }
    Err(AppError::BadRequest("missing multipart field `file`".into()))
}
