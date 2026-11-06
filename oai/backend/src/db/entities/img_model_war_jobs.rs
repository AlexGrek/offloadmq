use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Img Model Wars run: one prompt rendered by several `imggen.*` models. Each
/// slot in `slots_json` points at an ordinary image-generation child job, which
/// owns its offload task, buckets and output file.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "img_model_war_jobs")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
    /// `submitting` while child jobs are being created, then `submitted`. The
    /// user-facing run status is derived from the children at read time.
    pub status: String,
    pub params_json: String,
    pub slots_json: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
