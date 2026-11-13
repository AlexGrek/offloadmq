//! `personas` rows. Validation and token rendering live in `services::personas`.

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder,
};

use crate::{
    db::entities::personas::{self, Column, Entity},
    error::AppError,
};

pub type Persona = personas::Model;

/// Already-validated persona fields, written verbatim.
pub struct PersonaFields {
    pub name: String,
    pub system_prompt: String,
    pub look: String,
    pub face_image_ids_json: String,
    pub llm_capability: Option<String>,
    pub txt2img_capability: Option<String>,
    pub img2img_capability: Option<String>,
    pub face_swap_capability: Option<String>,
    pub upscaler_capability: Option<String>,
}

pub async fn create(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    f: PersonaFields,
) -> Result<Persona, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    Ok(personas::ActiveModel {
        id: Set(id),
        user_id: Set(user_id),
        name: Set(f.name),
        system_prompt: Set(f.system_prompt),
        look: Set(f.look),
        face_image_ids_json: Set(f.face_image_ids_json),
        llm_capability: Set(f.llm_capability),
        txt2img_capability: Set(f.txt2img_capability),
        img2img_capability: Set(f.img2img_capability),
        face_swap_capability: Set(f.face_swap_capability),
        upscaler_capability: Set(f.upscaler_capability),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(db)
    .await?)
}

pub async fn update(
    db: &DatabaseConnection,
    id: i64,
    f: PersonaFields,
) -> Result<Persona, AppError> {
    Ok(personas::ActiveModel {
        id: Set(id),
        name: Set(f.name),
        system_prompt: Set(f.system_prompt),
        look: Set(f.look),
        face_image_ids_json: Set(f.face_image_ids_json),
        llm_capability: Set(f.llm_capability),
        txt2img_capability: Set(f.txt2img_capability),
        img2img_capability: Set(f.img2img_capability),
        face_swap_capability: Set(f.face_swap_capability),
        upscaler_capability: Set(f.upscaler_capability),
        updated_at: Set(chrono::Utc::now().fixed_offset()),
        ..Default::default()
    }
    .update(db)
    .await?)
}

pub async fn get(db: &DatabaseConnection, id: i64, user_id: i64) -> Result<Persona, AppError> {
    Entity::find_by_id(id)
        .filter(Column::UserId.eq(user_id))
        .one(db)
        .await?
        .ok_or(AppError::NotFound)
}

/// Most recently edited first.
pub async fn list(db: &DatabaseConnection, user_id: i64) -> Result<Vec<Persona>, AppError> {
    Ok(Entity::find()
        .filter(Column::UserId.eq(user_id))
        .order_by_desc(Column::UpdatedAt)
        .all(db)
        .await?)
}

/// Deletes the persona; its chats and photo-job rows go with it (FK cascade).
pub async fn delete(db: &DatabaseConnection, id: i64, user_id: i64) -> Result<(), AppError> {
    let res = Entity::delete_many()
        .filter(Column::Id.eq(id))
        .filter(Column::UserId.eq(user_id))
        .exec(db)
        .await?;
    if res.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}
