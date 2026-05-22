use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "image_generation_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub status: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub capability: String,
    pub workflow: String,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    pub input_image_id: Option<i64>,
    pub error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::image_files::Entity")]
    ImageFiles,
    #[sea_orm(has_many = "super::image_pipeline_events::Entity")]
    ImagePipelineEvents,
    #[sea_orm(has_many = "super::image_offload_tasks::Entity")]
    ImageOffloadTasks,
}

impl Related<super::image_files::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ImageFiles.def()
    }
}

impl Related<super::image_pipeline_events::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ImagePipelineEvents.def()
    }
}

impl Related<super::image_offload_tasks::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ImageOffloadTasks.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
