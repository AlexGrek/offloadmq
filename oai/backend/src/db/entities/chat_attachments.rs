use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "chat_attachments")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    /// Set once the attachment is linked to a sent user message; null while it is
    /// only pre-uploaded and not yet referenced by a `chat` command.
    pub message_id: Option<i64>,
    pub chat_id: Option<i64>,
    /// "image" | "document"
    pub kind: String,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    /// For `kind="image"`: references `image_files.id` (uploads + generated).
    pub image_file_id: Option<i64>,
    /// For `kind="document"`: OAI storage path of the stored document bytes.
    pub storage_path: Option<String>,
    pub sha256: Option<String>,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
