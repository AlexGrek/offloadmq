use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "chat_messages")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub chat_id: i64,
    /// "user" | "assistant" | "system"
    pub role: String,
    pub content: String,
    /// "pending" (assistant reply in flight) | "complete" | "failed"
    pub status: String,
    /// capability used, e.g. "llm.qwen3:8b"; null for user/system messages
    pub model: Option<String>,
    /// Offload task capability for an in-flight assistant reply; null otherwise.
    pub offload_cap: Option<String>,
    /// Offload task id for an in-flight assistant reply; the background worker
    /// reconciles `status="pending"` rows that carry one. Null otherwise.
    pub offload_task_id: Option<String>,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::chats::Entity",
        from = "Column::ChatId",
        to = "super::chats::Column::Id",
        on_delete = "Cascade"
    )]
    Chat,
}

impl Related<super::chats::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Chat.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
