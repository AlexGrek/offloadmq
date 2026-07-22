use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "img_utils_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    pub status: String,
    /// Full OffloadMQ base capability, e.g. `img-utils.depth`.
    pub capability: String,
    /// Capability minus the `img-utils.` prefix, e.g. `depth`. Kept denormalized
    /// so listings can group by tool without re-parsing.
    pub utility: String,
    /// Task type sent as `payload.workflow` — defaults to `utility`.
    pub workflow: String,
    /// `image_files` row staged as `payload.input_image`.
    pub input_image_id: Option<i64>,
    /// `image_files` row staged as `payload.face_swap` (face-swap donor).
    pub source_image_id: Option<i64>,
    /// Extra workflow knobs, forwarded verbatim as `payload.secondary_prompts`.
    pub options_json: Option<String>,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub output_bucket_uid: Option<String>,
    /// `image_files` row holding the produced image.
    pub output_image_id: Option<i64>,
    pub stage: Option<String>,
    pub error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
