//! `persona_photo_jobs` — parent rows of the persona photo chain. Mirrors
//! `db::image_cycles` (steps live in JSON; children are ordinary jobs).

use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::{
    db::entities::persona_photo_jobs::{self, Column, Entity},
    error::AppError,
};

pub type Job = persona_photo_jobs::Model;

pub struct NewJob {
    pub id: i64,
    pub user_id: i64,
    pub persona_id: i64,
    pub prompt_template: String,
    pub prompt: String,
    pub params_json: String,
    pub steps_json: String,
}

pub async fn create(db: &DatabaseConnection, j: NewJob) -> Result<Job, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    Ok(persona_photo_jobs::ActiveModel {
        id: Set(j.id),
        user_id: Set(j.user_id),
        persona_id: Set(j.persona_id),
        created_at: Set(now),
        updated_at: Set(now),
        status: Set("running".into()),
        prompt_template: Set(j.prompt_template),
        prompt: Set(j.prompt),
        params_json: Set(j.params_json),
        steps_json: Set(j.steps_json),
        final_image_id: Set(None),
        error: Set(None),
    }
    .insert(db)
    .await?)
}

pub async fn get(db: &DatabaseConnection, id: i64, user_id: i64) -> Result<Job, AppError> {
    Entity::find_by_id(id)
        .filter(Column::UserId.eq(user_id))
        .one(db)
        .await?
        .ok_or(AppError::NotFound)
}

/// Newest first, capped at `limit`.
pub async fn list_for_persona(
    db: &DatabaseConnection,
    user_id: i64,
    persona_id: i64,
    limit: u64,
) -> Result<Vec<Job>, AppError> {
    Ok(Entity::find()
        .filter(Column::UserId.eq(user_id))
        .filter(Column::PersonaId.eq(persona_id))
        .order_by_desc(Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await?)
}

pub async fn inflight(db: &DatabaseConnection, limit: u64) -> Result<Vec<Job>, AppError> {
    Ok(Entity::find()
        .filter(Column::Status.is_in(["running", "cancelRequested"]))
        .order_by_asc(Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await?)
}

pub async fn save(db: &DatabaseConnection, job: &mut Job, steps: String) -> Result<(), AppError> {
    job.steps_json = steps;
    job.updated_at = chrono::Utc::now().fixed_offset();
    persona_photo_jobs::ActiveModel {
        id: Set(job.id),
        status: Set(job.status.clone()),
        updated_at: Set(job.updated_at),
        steps_json: Set(job.steps_json.clone()),
        final_image_id: Set(job.final_image_id),
        error: Set(job.error.clone()),
        ..Default::default()
    }
    .update(db)
    .await?;
    Ok(())
}

pub async fn delete(db: &DatabaseConnection, id: i64, user_id: i64) -> Result<(), AppError> {
    Entity::delete_many()
        .filter(Column::Id.eq(id))
        .filter(Column::UserId.eq(user_id))
        .exec(db)
        .await?;
    Ok(())
}

pub async fn fail_stale(
    db: &DatabaseConnection,
    cutoff: chrono::DateTime<chrono::FixedOffset>,
    reason: &str,
) -> Result<u64, AppError> {
    use sea_orm::sea_query::Expr;
    Ok(Entity::update_many()
        .col_expr(Column::Status, Expr::value("failed"))
        .col_expr(Column::Error, Expr::value(reason))
        .filter(Column::Status.is_in(["running", "cancelRequested"]))
        .filter(Column::UpdatedAt.lt(cutoff))
        .exec(db)
        .await?
        .rows_affected)
}

/// Non-blocking advisory lock on a run (`None` = someone else is advancing it).
pub async fn lock(
    db: &DatabaseConnection,
    id: i64,
) -> Result<Option<sea_orm::DatabaseTransaction>, AppError> {
    crate::db::image_cycles::lock(db, id, false).await
}

/// Blocking advisory lock, for cancel/delete.
pub async fn lock_wait(
    db: &DatabaseConnection,
    id: i64,
) -> Result<sea_orm::DatabaseTransaction, AppError> {
    crate::db::image_cycles::lock(db, id, true)
        .await?
        .ok_or_else(|| AppError::Internal("missing persona photo lock".into()))
}
