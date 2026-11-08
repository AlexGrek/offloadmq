use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// An image-generation request the user stashed instead of submitting. Starting it
/// deletes the row and submits the stored request as an ordinary image job.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "image_stash_entries")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    /// The `POST /api/images/jobs` body (`StartJobParams`) as JSON, with the prompt
    /// still unexpanded — placeholders are resolved when the entry is started.
    pub request_json: String,
    pub created_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
