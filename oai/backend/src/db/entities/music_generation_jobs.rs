use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "music_generation_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub status: String,
    pub capability: String,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub output_bucket_uid: Option<String>,
    pub tags: String,
    pub lyrics: Option<String>,
    pub bpm: Option<i32>,
    pub duration: i32,
    pub seed: Option<i32>,
    pub language: Option<String>,
    pub keyscale: Option<String>,
    pub cfg_scale: Option<f64>,
    pub temperature: Option<f64>,
    pub result_seed: Option<i32>,
    pub audio_files_json: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
