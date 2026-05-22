use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "users")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    #[sea_orm(unique)]
    pub login: String,
    #[serde(skip_serializing)]
    pub password_hash: Option<String>,
    #[sea_orm(unique)]
    pub google_id: Option<String>,
    pub created_at: DateTimeWithTimeZone,
    pub last_quotas_update_timestamp: Option<DateTimeWithTimeZone>,
    pub is_admin: Option<bool>,
    /// Cached total of `image_files.stored_bytes` owned by this user.
    /// Recalculated on every upload and offload download (see `image_jobs::store_image`).
    pub used_storage_bytes: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
