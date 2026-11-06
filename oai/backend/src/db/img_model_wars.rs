//! Img Model Wars run persistence. The row stores only the shared request and the
//! model → child image-job mapping; child jobs hold all progress and outputs.

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::{
    db::entities::img_model_war_jobs::{self, Column, Entity},
    error::AppError,
};

pub type Job = img_model_war_jobs::Model;

pub async fn create(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    params_json: String,
    slots_json: String,
) -> Result<Job, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    Ok(img_model_war_jobs::ActiveModel {
        id: Set(id),
        user_id: Set(user_id),
        created_at: Set(now),
        updated_at: Set(now),
        status: Set("submitting".into()),
        params_json: Set(params_json),
        slots_json: Set(slots_json),
    }
    .insert(db)
    .await?)
}

pub async fn update(
    db: &DatabaseConnection,
    id: i64,
    status: &str,
    slots_json: String,
) -> Result<(), AppError> {
    img_model_war_jobs::ActiveModel {
        id: Set(id),
        updated_at: Set(chrono::Utc::now().fixed_offset()),
        status: Set(status.to_owned()),
        slots_json: Set(slots_json),
        ..Default::default()
    }
    .update(db)
    .await?;
    Ok(())
}

pub async fn get(db: &DatabaseConnection, id: i64, user_id: i64) -> Result<Job, AppError> {
    Entity::find_by_id(id)
        .filter(Column::UserId.eq(user_id))
        .one(db)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn list(db: &DatabaseConnection, user_id: i64, limit: u64) -> Result<Vec<Job>, AppError> {
    Ok(Entity::find()
        .filter(Column::UserId.eq(user_id))
        .order_by_desc(Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await?)
}

pub async fn delete(db: &DatabaseConnection, id: i64, user_id: i64) -> Result<(), AppError> {
    let result = Entity::delete_many()
        .filter(Column::Id.eq(id))
        .filter(Column::UserId.eq(user_id))
        .exec(db)
        .await?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}
