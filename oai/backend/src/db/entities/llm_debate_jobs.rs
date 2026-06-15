use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "llm_debate_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub status: String,
    pub model_a: String,
    pub model_b: String,
    pub system_a: String,
    pub system_b: String,
    pub initial_prompt: String,
    pub referee_enabled: bool,
    pub model_ref: Option<String>,
    pub system_ref: Option<String>,
    pub command_ref: Option<String>,
    pub referee_turns: i32,
    pub messages_json: String,
    pub phase: String,
    pub current_turn: Option<String>,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub active_log: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
