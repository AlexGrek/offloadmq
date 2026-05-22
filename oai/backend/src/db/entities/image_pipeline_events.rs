use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "image_pipeline_events")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub job_id: i64,
    pub step: String,
    pub state: String,
    pub details: Option<String>,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::image_generation_jobs::Entity",
        from = "Column::JobId",
        to = "super::image_generation_jobs::Column::Id",
        on_delete = "Cascade"
    )]
    ImageGenerationJob,
}

impl Related<super::image_generation_jobs::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ImageGenerationJob.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
