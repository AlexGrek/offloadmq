//! Data access for `chat_attachments` — per-message attachment instances that
//! point at either an `image_files` row (images: uploads + generated) or an OAI
//! storage path (documents). No business logic / OffloadMQ calls here.

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, sea_query::Expr,
};

use crate::{
    db::entities::chat_attachments::{self, Entity as ChatAttachmentEntity},
    error::AppError,
};

pub type ChatAttachment = chat_attachments::Model;

pub struct NewAttachmentInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub kind: &'a str,
    pub filename: &'a str,
    pub content_type: &'a str,
    pub size_bytes: i64,
    pub image_file_id: Option<i64>,
    pub storage_path: Option<&'a str>,
    pub sha256: Option<&'a str>,
}

pub async fn create_attachment(
    db: &DatabaseConnection,
    input: NewAttachmentInput<'_>,
) -> Result<ChatAttachment, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = chat_attachments::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        message_id: ActiveValue::Set(None),
        chat_id: ActiveValue::Set(None),
        kind: ActiveValue::Set(input.kind.to_string()),
        filename: ActiveValue::Set(input.filename.to_string()),
        content_type: ActiveValue::Set(input.content_type.to_string()),
        size_bytes: ActiveValue::Set(input.size_bytes),
        image_file_id: ActiveValue::Set(input.image_file_id),
        storage_path: ActiveValue::Set(input.storage_path.map(str::to_string)),
        sha256: ActiveValue::Set(input.sha256.map(str::to_string)),
        created_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn get_attachment(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
) -> Result<Option<ChatAttachment>, AppError> {
    ChatAttachmentEntity::find_by_id(id)
        .filter(chat_attachments::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

/// Attachments linked to a single sent user message, oldest first.
pub async fn list_for_message(
    db: &DatabaseConnection,
    message_id: i64,
) -> Result<Vec<ChatAttachment>, AppError> {
    ChatAttachmentEntity::find()
        .filter(chat_attachments::Column::MessageId.eq(message_id))
        .order_by_asc(chat_attachments::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// All attachments for a set of messages (transcript hydration). Returns rows in
/// creation order; callers group by `message_id`.
pub async fn list_for_messages(
    db: &DatabaseConnection,
    message_ids: &[i64],
) -> Result<Vec<ChatAttachment>, AppError> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    ChatAttachmentEntity::find()
        .filter(chat_attachments::Column::MessageId.is_in(message_ids.iter().copied()))
        .order_by_asc(chat_attachments::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Distinct documents the user has uploaded before, newest first — backs the
/// "reference existing document" picker. Deduped by storage path so re-uses of
/// the same file collapse to one entry.
pub async fn list_user_documents(
    db: &DatabaseConnection,
    user_id: i64,
    limit: usize,
) -> Result<Vec<ChatAttachment>, AppError> {
    let rows = ChatAttachmentEntity::find()
        .filter(chat_attachments::Column::UserId.eq(user_id))
        .filter(chat_attachments::Column::Kind.eq("document"))
        .order_by_desc(chat_attachments::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)?;

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for row in rows {
        let key = row.storage_path.clone().unwrap_or_else(|| row.id.to_string());
        if seen.insert(key) {
            out.push(row);
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

/// Links a batch of pre-uploaded attachments to a sent user message. Only rows
/// owned by `user_id` and not yet linked are updated; returns the linked rows.
pub async fn link_to_message(
    db: &DatabaseConnection,
    attachment_ids: &[i64],
    user_id: i64,
    message_id: i64,
    chat_id: i64,
) -> Result<Vec<ChatAttachment>, AppError> {
    if attachment_ids.is_empty() {
        return Ok(Vec::new());
    }
    ChatAttachmentEntity::update_many()
        .col_expr(chat_attachments::Column::MessageId, Expr::value(message_id))
        .col_expr(chat_attachments::Column::ChatId, Expr::value(chat_id))
        .filter(chat_attachments::Column::Id.is_in(attachment_ids.iter().copied()))
        .filter(chat_attachments::Column::UserId.eq(user_id))
        .filter(chat_attachments::Column::MessageId.is_null())
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    list_for_message(db, message_id).await
}
