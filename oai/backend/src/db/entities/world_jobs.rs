use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// One VR Worlds job: a library image turned into a Gaussian-splat PLY by an
/// agent's `world.splat` capability.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "world_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub status: String,
    /// Base capability submitted, e.g. `world.splat`.
    pub capability: String,
    /// Requested projection: `auto`, `perspective` or `pano`. The agent reports
    /// the resolved one in `result_json.mode`.
    pub mode: String,
    /// Normalized request knobs (`max_width`, `fill_lean`, …) — replayed by retry.
    pub params_json: String,
    /// `image_files` row staged as `payload.input_image`. Null once deleted.
    pub input_image_id: Option<i64>,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub output_bucket_uid: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
    /// Agent result minus the bucket file refs (splat count, depth range, timings…).
    pub result_json: Option<String>,
    pub ply_path: Option<String>,
    pub preview_path: Option<String>,
    pub ply_bytes: Option<i64>,
    pub started_at: Option<DateTimeWithTimeZone>,
    pub typical_runtime_seconds: Option<f64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
