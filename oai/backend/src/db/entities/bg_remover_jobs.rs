use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "bg_remover_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub status: String,
    /// Full OffloadMQ base capability, e.g. `onnx.bgremove.birefnet-general`.
    pub capability: String,
    /// `image_files` row staged as `payload.input_image`.
    pub input_image_id: Option<i64>,
    /// The validated, normalized request options (see `services::bg_remover`),
    /// stored so retry replays exactly what ran.
    pub options_json: Option<String>,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub output_bucket_uid: Option<String>,
    /// `image_files` row holding the cutout.
    pub output_image_id: Option<i64>,
    /// Mean alpha of the result, reported by the agent. Near 0 → nothing was
    /// detected; near 1 → the background was kept.
    pub foreground_ratio: Option<f64>,
    pub stage: Option<String>,
    pub error: Option<String>,
    /// Stamped once, the first time a poll shows the task executing on an agent.
    pub started_at: Option<DateTimeWithTimeZone>,
    /// Latest OffloadMQ execution-time estimate for this task, in seconds.
    pub typical_runtime_seconds: Option<f64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
