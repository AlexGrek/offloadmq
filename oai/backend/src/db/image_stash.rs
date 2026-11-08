//! Stashed image-generation requests (`image_stash_entries`): per-user CRUD plus an
//! atomic "take" used when an entry is started. Request validation and job
//! submission live in `services::image_stash`.

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder,
};

use crate::{
    db::entities::image_stash_entries::{self, Entity as StashEntity},
    error::AppError,
};

pub type StashEntry = image_stash_entries::Model;

/// Newest first.
pub async fn list_for_user(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<Vec<StashEntry>, AppError> {
    StashEntity::find()
        .filter(image_stash_entries::Column::UserId.eq(user_id))
        .order_by_desc(image_stash_entries::Column::CreatedAt)
        .order_by_desc(image_stash_entries::Column::Id)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn count_for_user(db: &DatabaseConnection, user_id: i64) -> Result<u64, AppError> {
    StashEntity::find()
        .filter(image_stash_entries::Column::UserId.eq(user_id))
        .count(db)
        .await
        .map_err(AppError::Database)
}

pub async fn create(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    request_json: String,
) -> Result<StashEntry, AppError> {
    image_stash_entries::ActiveModel {
        id: ActiveValue::Set(id),
        user_id: ActiveValue::Set(user_id),
        request_json: ActiveValue::Set(request_json),
        created_at: ActiveValue::Set(chrono::Utc::now().fixed_offset()),
    }
    .insert(db)
    .await
    .map_err(AppError::Database)
}

/// Put back an entry removed by [`take`] (same id and `created_at`, so it keeps
/// its place in the list).
pub async fn restore(db: &DatabaseConnection, entry: StashEntry) -> Result<(), AppError> {
    image_stash_entries::ActiveModel {
        id: ActiveValue::Set(entry.id),
        user_id: ActiveValue::Set(entry.user_id),
        request_json: ActiveValue::Set(entry.request_json),
        created_at: ActiveValue::Set(entry.created_at),
    }
    .insert(db)
    .await
    .map_err(AppError::Database)?;
    Ok(())
}

pub async fn delete(db: &DatabaseConnection, user_id: i64, id: i64) -> Result<(), AppError> {
    let result = StashEntity::delete_many()
        .filter(image_stash_entries::Column::Id.eq(id))
        .filter(image_stash_entries::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// Remove an entry and return it. Only the caller whose delete actually removed
/// the row gets it back, so two concurrent starts of one entry submit one job.
pub async fn take(db: &DatabaseConnection, user_id: i64, id: i64) -> Result<StashEntry, AppError> {
    let entry = StashEntity::find_by_id(id)
        .filter(image_stash_entries::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)?
        .ok_or(AppError::NotFound)?;
    delete(db, user_id, id).await?;
    Ok(entry)
}
