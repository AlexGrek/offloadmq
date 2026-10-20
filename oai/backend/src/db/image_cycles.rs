//! Persistent multi-step orchestration. Child describe and image jobs retain
//! their existing offload lifecycle, bucket cleanup, and file storage.
use crate::{
    db::entities::image_cycle_jobs::{self, Column, Entity},
    error::AppError,
};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait, DatabaseConnection,
    DatabaseTransaction, DbBackend, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Statement,
    TransactionTrait,
};
pub type Job = image_cycle_jobs::Model;

pub async fn create(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    app: &str,
    params: String,
    steps: String,
) -> Result<Job, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    Ok(image_cycle_jobs::ActiveModel {
        id: Set(id),
        user_id: Set(user_id),
        app: Set(app.to_owned()),
        created_at: Set(now),
        updated_at: Set(now),
        status: Set("running".into()),
        params_json: Set(params),
        steps_json: Set(steps),
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

pub async fn list(db: &DatabaseConnection, user_id: i64, app: &str) -> Result<Vec<Job>, AppError> {
    Ok(Entity::find()
        .filter(Column::App.eq(app))
        .filter(Column::UserId.eq(user_id))
        .order_by_desc(Column::CreatedAt)
        .limit(100)
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
    image_cycle_jobs::ActiveModel {
        id: Set(job.id),
        status: Set(job.status.clone()),
        updated_at: Set(job.updated_at),
        steps_json: Set(job.steps_json.clone()),
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

/// A database-wide advisory lock serializes advance/cancel/delete across tabs,
/// workers and pods. Parent writes deliberately use the pool outside this
/// transaction: child IDs must be durable BEFORE submitting remote work.
pub async fn lock(
    db: &DatabaseConnection,
    id: i64,
    wait: bool,
) -> Result<Option<DatabaseTransaction>, AppError> {
    let tx = db.begin().await?;
    if wait {
        tx.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT pg_advisory_xact_lock($1)",
            [id.into()],
        ))
        .await?;
    } else {
        let row = tx
            .query_one(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT pg_try_advisory_xact_lock($1) AS acquired",
                [id.into()],
            ))
            .await?
            .ok_or_else(|| AppError::Internal("missing advisory lock result".into()))?;
        if !row.try_get::<bool>("", "acquired")? {
            return Ok(None);
        }
    }
    Ok(Some(tx))
}
