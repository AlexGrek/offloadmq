use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "image_files")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub job_id: Option<i64>,
    pub direction: String,
    pub source: String,
    pub storage_path: String,
    pub filename: String,
    pub content_type: String,
    pub original_bytes: Option<i64>,
    pub stored_bytes: i64,
    pub original_width: Option<i32>,
    pub original_height: Option<i32>,
    pub stored_width: i32,
    pub stored_height: i32,
    pub exif_orientation: Option<i32>,
    pub rescaled: bool,
    pub reencoded: bool,
    pub sha256: String,
    pub offload_bucket_uid: Option<String>,
    pub offload_file_uid: Option<String>,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::image_generation_jobs::Entity",
        from = "Column::JobId",
        to = "super::image_generation_jobs::Column::Id",
        on_delete = "SetNull"
    )]
    ImageGenerationJob,
}

impl Related<super::image_generation_jobs::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::ImageGenerationJob.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
