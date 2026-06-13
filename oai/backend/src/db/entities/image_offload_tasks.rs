use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "image_offload_tasks")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub job_id: i64,
    pub offload_cap: String,
    pub offload_task_id: String,
    pub submit_payload: String,
    pub last_poll_status: Option<String>,
    pub last_poll_stage: Option<String>,
    pub last_poll_log: Option<String>,
    pub last_poll_output: Option<String>,
    pub submitted_at: DateTimeWithTimeZone,
    /// When the task first began executing on an agent (status `starting`/`running`),
    /// as opposed to `submitted_at` (queue time). Drives the run-time progress bar.
    pub started_at: Option<DateTimeWithTimeZone>,
    pub updated_at: DateTimeWithTimeZone,
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
