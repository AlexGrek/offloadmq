use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, sea_query::Expr,
};

use crate::{
    db::entities::{
        chat_messages::{self, Entity as ChatMessageEntity},
        chats::{self, Entity as ChatEntity},
    },
    error::AppError,
};

pub type Chat = chats::Model;
pub type ChatMessage = chat_messages::Model;

pub async fn create_chat(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    system_prompt: &str,
) -> Result<Chat, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = chats::ActiveModel {
        id: ActiveValue::Set(id),
        user_id: ActiveValue::Set(user_id),
        title: ActiveValue::Set(String::new()),
        system_prompt: ActiveValue::Set(system_prompt.to_string()),
        last_model: ActiveValue::Set(None),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn set_last_model(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    last_model: &str,
) -> Result<Chat, AppError> {
    let chat = get_chat(db, id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let now = chrono::Utc::now().fixed_offset();
    let mut am: chats::ActiveModel = chat.into();
    am.last_model = ActiveValue::Set(Some(last_model.to_string()));
    am.updated_at = ActiveValue::Set(now);
    am.update(db).await.map_err(AppError::Database)
}

pub async fn set_system_prompt(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    system_prompt: &str,
) -> Result<Chat, AppError> {
    let chat = get_chat(db, id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let now = chrono::Utc::now().fixed_offset();
    let mut am: chats::ActiveModel = chat.into();
    am.system_prompt = ActiveValue::Set(system_prompt.to_string());
    am.updated_at = ActiveValue::Set(now);
    am.update(db).await.map_err(AppError::Database)
}

pub async fn list_chats(db: &DatabaseConnection, user_id: i64) -> Result<Vec<Chat>, AppError> {
    ChatEntity::find()
        .filter(chats::Column::UserId.eq(user_id))
        .order_by_desc(chats::Column::UpdatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn get_chat(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
) -> Result<Option<Chat>, AppError> {
    ChatEntity::find_by_id(id)
        .filter(chats::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn delete_chat(db: &DatabaseConnection, id: i64, user_id: i64) -> Result<(), AppError> {
    let result = ChatEntity::delete_many()
        .filter(chats::Column::Id.eq(id))
        .filter(chats::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn set_title(db: &DatabaseConnection, id: i64, title: &str) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = chats::ActiveModel {
        id: ActiveValue::Set(id),
        title: ActiveValue::Set(title.to_string()),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn touch_chat(db: &DatabaseConnection, id: i64) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = chats::ActiveModel {
        id: ActiveValue::Set(id),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn get_messages(
    db: &DatabaseConnection,
    chat_id: i64,
) -> Result<Vec<ChatMessage>, AppError> {
    ChatMessageEntity::find()
        .filter(chat_messages::Column::ChatId.eq(chat_id))
        .order_by_asc(chat_messages::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn add_message(
    db: &DatabaseConnection,
    id: i64,
    chat_id: i64,
    role: &str,
    content: &str,
    status: &str,
    model: Option<&str>,
) -> Result<ChatMessage, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let msg = chat_messages::ActiveModel {
        id: ActiveValue::Set(id),
        chat_id: ActiveValue::Set(chat_id),
        role: ActiveValue::Set(role.to_string()),
        content: ActiveValue::Set(content.to_string()),
        status: ActiveValue::Set(status.to_string()),
        model: ActiveValue::Set(model.map(str::to_string)),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        created_at: ActiveValue::Set(now),
    };
    msg.insert(db).await.map_err(AppError::Database)
}

/// Inserts the assistant reply as `status="pending"` with the offload task it is
/// waiting on. The poll loop (live) or the background worker (after a disconnect
/// or pod restart) finalizes it via [`finalize_message`].
pub async fn add_pending_assistant_message(
    db: &DatabaseConnection,
    id: i64,
    chat_id: i64,
    model: &str,
    offload_cap: &str,
    offload_task_id: &str,
) -> Result<ChatMessage, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let msg = chat_messages::ActiveModel {
        id: ActiveValue::Set(id),
        chat_id: ActiveValue::Set(chat_id),
        role: ActiveValue::Set("assistant".to_string()),
        content: ActiveValue::Set(String::new()),
        status: ActiveValue::Set("pending".to_string()),
        model: ActiveValue::Set(Some(model.to_string())),
        offload_cap: ActiveValue::Set(Some(offload_cap.to_string())),
        offload_task_id: ActiveValue::Set(Some(offload_task_id.to_string())),
        created_at: ActiveValue::Set(now),
    };
    msg.insert(db).await.map_err(AppError::Database)
}

/// Idempotently writes the final content/status of a pending assistant message.
/// Only rows still `status="pending"` are touched, so the live poll loop and the
/// background worker can race without double-writing. Returns rows affected.
pub async fn finalize_message(
    db: &DatabaseConnection,
    id: i64,
    content: &str,
    status: &str,
) -> Result<u64, AppError> {
    let res = ChatMessageEntity::update_many()
        .col_expr(chat_messages::Column::Content, Expr::value(content.to_string()))
        .col_expr(chat_messages::Column::Status, Expr::value(status.to_string()))
        .filter(chat_messages::Column::Id.eq(id))
        .filter(chat_messages::Column::Status.eq("pending"))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(res.rows_affected)
}

/// In-flight assistant replies awaiting reconciliation, oldest first. The
/// background worker polls each one's offload task and finalizes it.
pub async fn list_pending_assistant_messages(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ChatMessage>, AppError> {
    ChatMessageEntity::find()
        .filter(chat_messages::Column::Status.eq("pending"))
        .filter(chat_messages::Column::OffloadTaskId.is_not_null())
        .order_by_asc(chat_messages::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}
