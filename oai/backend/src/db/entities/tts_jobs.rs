use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "tts_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub status: String,
    pub text: String,
    pub capability: String,
    pub voice: String,
    pub model: String,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub audio_storage_path: Option<String>,
    pub audio_content_type: Option<String>,
    pub audio_size_bytes: Option<i64>,
    pub stage: Option<String>,
    pub error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
