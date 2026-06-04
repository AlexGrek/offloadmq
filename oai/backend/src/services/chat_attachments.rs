//! Chat attachment orchestration: persist user-supplied documents/images,
//! reference existing files, and stage them into a one-shot OffloadMQ bucket so
//! the agent can extract document text and attach images to an `llm.*` task.
//!
//! Images reuse the existing `image_files` store (uploads + AI-generated, served
//! via `/api/images/files/{id}`). Documents are stored under
//! `users/{uid}/chat_docs/{attachment_id}.{ext}` and served via
//! `/api/chat/attachments/{id}/download`.

use sha2::{Digest, Sha256};

use crate::{
    db::{chat_attachments, image_generation},
    error::AppError,
    services::{offload_factory, storage},
    state::AppState,
};

/// Max attachments accepted on a single chat turn.
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 10;
/// Max bytes for a single uploaded document.
pub const MAX_DOCUMENT_BYTES: usize = 100 * 1024 * 1024;

/// Document extensions the offload agent can extract text from
/// (`offload-agent/app/data/text_extract.py`).
pub const DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf", "txt", "md", "csv", "json", "xml", "yml", "yaml", "log",
];

/// Serializable view of an attachment for API responses.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AttachmentDto {
    pub id: String,
    pub kind: String,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    /// `image_files.id` for image attachments (frontend builds preview URLs).
    pub image_id: Option<String>,
    pub created_at: String,
}

pub fn to_dto(att: &chat_attachments::ChatAttachment) -> AttachmentDto {
    AttachmentDto {
        id: att.id.to_string(),
        kind: att.kind.clone(),
        filename: att.filename.clone(),
        content_type: att.content_type.clone(),
        size_bytes: att.size_bytes,
        image_id: att.image_file_id.map(|i| i.to_string()),
        created_at: att.created_at.to_rfc3339(),
    }
}

fn extension_for(filename: &str) -> Option<String> {
    std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Stores a newly uploaded document and records a `chat_attachments` row.
pub async fn upload_document(
    state: &AppState,
    user_id: i64,
    filename: String,
    bytes: Vec<u8>,
    content_type: String,
) -> Result<chat_attachments::ChatAttachment, AppError> {
    let op = storage::operator(state)?;

    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty file".into()));
    }
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(AppError::BadRequest(format!(
            "document exceeds max size of {} MiB",
            MAX_DOCUMENT_BYTES / (1024 * 1024)
        )));
    }
    let ext = extension_for(&filename).unwrap_or_default();
    if !DOCUMENT_EXTENSIONS.contains(&ext.as_str()) {
        return Err(AppError::BadRequest(format!(
            "unsupported document type `.{ext}`; supported: {}",
            DOCUMENT_EXTENSIONS.join(", ")
        )));
    }

    let attachment_id = state.next_id();
    let storage_path = format!("users/{user_id}/chat_docs/{attachment_id}.{ext}");
    let size_bytes = bytes.len() as i64;
    let sha = {
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        hex::encode(hasher.finalize())
    };
    storage::write(op, &storage_path, bytes).await?;

    chat_attachments::create_attachment(
        &state.db,
        chat_attachments::NewAttachmentInput {
            id: attachment_id,
            user_id,
            kind: "document",
            filename: &filename,
            content_type: &content_type,
            size_bytes,
            image_file_id: None,
            storage_path: Some(&storage_path),
            sha256: Some(&sha),
        },
    )
    .await
}

/// Records an image attachment that references an existing `image_files` row
/// (a new composer upload via `/api/images/upload`, or a referenced
/// uploaded/generated image).
pub async fn create_image_attachment(
    state: &AppState,
    user_id: i64,
    image_id: i64,
) -> Result<chat_attachments::ChatAttachment, AppError> {
    let image = image_generation::get_image_file(&state.db, image_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;

    let attachment_id = state.next_id();
    chat_attachments::create_attachment(
        &state.db,
        chat_attachments::NewAttachmentInput {
            id: attachment_id,
            user_id,
            kind: "image",
            filename: &image.filename,
            content_type: &image.content_type,
            size_bytes: image.stored_bytes,
            image_file_id: Some(image.id),
            storage_path: None,
            sha256: Some(&image.sha256),
        },
    )
    .await
}

/// Re-references a previously uploaded document as a fresh attachment row,
/// sharing the underlying stored bytes.
pub async fn reference_document(
    state: &AppState,
    user_id: i64,
    source_attachment_id: i64,
) -> Result<chat_attachments::ChatAttachment, AppError> {
    let source = chat_attachments::get_attachment(&state.db, source_attachment_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if source.kind != "document" {
        return Err(AppError::BadRequest("attachment is not a document".into()));
    }
    let storage_path = source
        .storage_path
        .clone()
        .ok_or_else(|| AppError::BadRequest("document has no stored bytes".into()))?;

    let attachment_id = state.next_id();
    chat_attachments::create_attachment(
        &state.db,
        chat_attachments::NewAttachmentInput {
            id: attachment_id,
            user_id,
            kind: "document",
            filename: &source.filename,
            content_type: &source.content_type,
            size_bytes: source.size_bytes,
            image_file_id: None,
            storage_path: Some(&storage_path),
            sha256: source.sha256.as_deref(),
        },
    )
    .await
}

pub async fn list_documents(
    state: &AppState,
    user_id: i64,
) -> Result<Vec<chat_attachments::ChatAttachment>, AppError> {
    chat_attachments::list_user_documents(&state.db, user_id, 100).await
}

/// Raw bytes of a document attachment for the download endpoint.
pub async fn document_bytes(
    state: &AppState,
    user_id: i64,
    attachment_id: i64,
) -> Result<(Vec<u8>, String, String), AppError> {
    let att = chat_attachments::get_attachment(&state.db, attachment_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if att.kind != "document" {
        return Err(AppError::BadRequest("attachment is not a document".into()));
    }
    let path = att.storage_path.ok_or(AppError::NotFound)?;
    let op = storage::operator(state)?;
    let bytes = storage::read(op, &path).await?;
    Ok((bytes, att.content_type, att.filename))
}

/// Stages the given attachments into a fresh one-shot OffloadMQ bucket and
/// returns its uid. Returns `None` when there are no attachments. The bucket is
/// created with `rm_after_task=true` so OffloadMQ cleans it up after the task.
pub async fn stage_into_bucket(
    state: &AppState,
    attachments: &[chat_attachments::ChatAttachment],
) -> Result<Option<String>, AppError> {
    if attachments.is_empty() {
        return Ok(None);
    }
    let op = storage::operator(state)?;
    let img_client = offload_factory::image_client(state).await?;
    let bucket = img_client.create_bucket(true).await?;

    for att in attachments {
        let (bytes, content_type, filename) = match att.kind.as_str() {
            "image" => {
                let image_id = att
                    .image_file_id
                    .ok_or_else(|| AppError::Internal("image attachment missing image id".into()))?;
                let image = image_generation::get_image_file(&state.db, image_id, att.user_id)
                    .await?
                    .ok_or(AppError::NotFound)?;
                let bytes = storage::read(op, &image.storage_path).await?;
                (bytes, image.content_type, image.filename)
            }
            "document" => {
                let path = att
                    .storage_path
                    .clone()
                    .ok_or_else(|| AppError::Internal("document attachment missing path".into()))?;
                let bytes = storage::read(op, &path).await?;
                (bytes, att.content_type.clone(), att.filename.clone())
            }
            other => {
                return Err(AppError::Internal(format!("unknown attachment kind: {other}")));
            }
        };
        img_client
            .upload_bucket_file(&bucket.bucket_uid, bytes, &filename, &content_type)
            .await?;
    }

    Ok(Some(bucket.bucket_uid))
}
