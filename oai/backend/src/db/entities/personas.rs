use sea_orm::entity::prelude::*;

/// A user's persona — see `services::personas`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personas")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub system_prompt: String,
    #[sea_orm(column_type = "Text")]
    pub look: String,
    /// Ordered JSON array of `image_files` ids (strings); the first is the primary face.
    #[sea_orm(column_type = "Text")]
    pub face_image_ids_json: String,
    pub llm_capability: Option<String>,
    pub txt2img_capability: Option<String>,
    pub img2img_capability: Option<String>,
    pub face_swap_capability: Option<String>,
    pub upscaler_capability: Option<String>,
    pub created_at: DateTimeWithTimeZone,
    pub updated_at: DateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}
