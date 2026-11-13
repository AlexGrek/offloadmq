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

/// What a `chats` row is used for. Both kinds share messages, attachments, the WS
/// `chat` command and the reconcile worker; they differ only in which page lists
/// them, their default system prompt and which prompt-library bucket records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatKind {
    /// LLM Chat (`/app/chat`).
    Chat,
    /// Prompt Studio (`/app/prompt-studio`).
    PromptStudio,
    /// A persona's chat (`/app/personas`): `chats.persona_id` is set and the
    /// persona's rendered system prompt is used at send time.
    Persona,
}

impl ChatKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatKind::Chat => "chat",
            ChatKind::PromptStudio => "prompt_studio",
            ChatKind::Persona => "persona",
        }
    }

    /// Parses the API/DB value. Unknown values are rejected (400 at the API).
    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value.trim() {
            "chat" => Ok(ChatKind::Chat),
            "prompt_studio" => Ok(ChatKind::PromptStudio),
            "persona" => Ok(ChatKind::Persona),
            other => Err(AppError::BadRequest(format!(
                "unknown chat kind: {other:?}"
            ))),
        }
    }

    /// Lenient parse for stored rows — anything unexpected behaves as a plain chat.
    pub fn from_stored(value: &str) -> Self {
        Self::parse(value).unwrap_or(ChatKind::Chat)
    }

    /// Prompt-library bucket that records this kind's system prompts as recents.
    pub fn system_prompt_bucket(self) -> &'static str {
        match self {
            ChatKind::Chat => "llm-system",
            ChatKind::PromptStudio => "prompt-studio-system",
            ChatKind::Persona => "persona-system",
        }
    }

    /// Default system prompt source when a new chat is created without one.
    pub fn default_prompt_app(self) -> crate::db::prompt_defaults::App {
        match self {
            ChatKind::Chat => crate::db::prompt_defaults::App::Chat,
            ChatKind::PromptStudio => crate::db::prompt_defaults::App::PromptStudioSystem,
            ChatKind::Persona => crate::db::prompt_defaults::App::Chat,
        }
    }
}

pub async fn create_chat(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    system_prompt: &str,
    kind: ChatKind,
    persona_id: Option<i64>,
) -> Result<Chat, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = chats::ActiveModel {
        id: ActiveValue::Set(id),
        user_id: ActiveValue::Set(user_id),
        title: ActiveValue::Set(String::new()),
        system_prompt: ActiveValue::Set(system_prompt.to_string()),
        last_model: ActiveValue::Set(None),
        kind: ActiveValue::Set(kind.as_str().to_string()),
        persona_id: ActiveValue::Set(persona_id),
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

pub async fn list_chats(
    db: &DatabaseConnection,
    user_id: i64,
    kind: ChatKind,
    persona_id: Option<i64>,
) -> Result<Vec<Chat>, AppError> {
    let mut query = ChatEntity::find()
        .filter(chats::Column::UserId.eq(user_id))
        .filter(chats::Column::Kind.eq(kind.as_str()));
    if let Some(persona_id) = persona_id {
        query = query.filter(chats::Column::PersonaId.eq(persona_id));
    }
    query
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

/// One message of a chat (the chat's ownership is checked by the caller).
pub async fn get_message(
    db: &DatabaseConnection,
    chat_id: i64,
    message_id: i64,
) -> Result<Option<ChatMessage>, AppError> {
    ChatMessageEntity::find_by_id(message_id)
        .filter(chat_messages::Column::ChatId.eq(chat_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

/// How often each model answered in the user's last `limit` assistant replies —
/// the "most used" ranking for picking a default LLM.
pub async fn recent_model_usage(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<std::collections::HashMap<String, u32>, AppError> {
    let chat_ids: Vec<i64> = ChatEntity::find()
        .filter(chats::Column::UserId.eq(user_id))
        .select_only()
        .column(chats::Column::Id)
        .into_tuple()
        .all(db)
        .await
        .map_err(AppError::Database)?;
    let mut usage = std::collections::HashMap::new();
    if chat_ids.is_empty() {
        return Ok(usage);
    }
    let models: Vec<Option<String>> = ChatMessageEntity::find()
        .filter(chat_messages::Column::ChatId.is_in(chat_ids))
        .filter(chat_messages::Column::Role.eq("assistant"))
        .order_by_desc(chat_messages::Column::CreatedAt)
        .limit(limit)
        .select_only()
        .column(chat_messages::Column::Model)
        .into_tuple()
        .all(db)
        .await
        .map_err(AppError::Database)?;
    for model in models.into_iter().flatten() {
        *usage.entry(crate::offload::base_capability(&model).to_string()).or_insert(0) += 1;
    }
    Ok(usage)
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

#[cfg(test)]
mod tests {
    use super::ChatKind;

    #[test]
    fn chat_kind_round_trips_and_picks_buckets() {
        for kind in [ChatKind::Chat, ChatKind::PromptStudio, ChatKind::Persona] {
            assert_eq!(ChatKind::parse(kind.as_str()).unwrap(), kind);
        }
        assert!(ChatKind::parse("movie").is_err());
        assert_eq!(ChatKind::from_stored("garbage"), ChatKind::Chat);
        assert_eq!(ChatKind::Chat.system_prompt_bucket(), "llm-system");
        assert_eq!(
            ChatKind::PromptStudio.system_prompt_bucket(),
            "prompt-studio-system"
        );
    }
}
