use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "movie_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub status: String,
    pub idea: String,
    pub width: i32,
    pub height: i32,
    pub scene_count: i32,
    pub scene_length: i32,
    pub long_shot: bool,
    pub auto_approve: bool,
    pub expand_prompt: bool,
    pub director_model: String,
    pub scene_model: String,
    pub video_capability: String,
    pub director_system: String,
    pub scene_system: String,
    pub initial_image_id: Option<i64>,
    pub phase: String,
    pub outline_json: String,
    pub scenes_json: String,
    pub current_scene: i32,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub active_log: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub movie_file_id: Option<i64>,
    pub raw_outline: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
