//! Generic data-access for the "offload job" table shape shared by every
//! submit→poll→persist feature (tts, image analysis, nude detect, music gen, …).
//!
//! Every such table has the same lifecycle columns: `id, user_id, status,
//! created_at, updated_at, offload_cap, offload_task_id, stage, error` (plus an
//! optional bucket column and feature-specific payload/result columns). Each
//! feature wires its SeaORM entity into the framework by implementing the two
//! small traits below; the boilerplate read/status writes then come for free.
//!
//! Feature-specific writes (`create_job`, `set_result`, `set_audio`, …) stay in
//! the per-feature `db/<feature>.rs` module since they touch unique columns.

use sea_orm::{
    sea_query::Expr, ColumnTrait, Condition, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};

use crate::error::AppError;

/// Read access to the lifecycle fields every job model shares. Implemented on
/// each entity's `Model`.
pub trait OffloadJobModel {
    fn id(&self) -> i64;
    fn status(&self) -> &str;
    fn offload_cap(&self) -> Option<&str>;
    fn offload_task_id(&self) -> Option<&str>;
}

/// Maps an entity's lifecycle columns so the generic queries below can be built
/// without knowing the concrete entity. Implemented on each `Entity`.
pub trait OffloadJobEntity: EntityTrait
where
    <Self as EntityTrait>::Model: OffloadJobModel,
{
    fn col_id() -> Self::Column;
    fn col_user_id() -> Self::Column;
    fn col_status() -> Self::Column;
    fn col_stage() -> Self::Column;
    fn col_error() -> Self::Column;
    fn col_created_at() -> Self::Column;
    fn col_updated_at() -> Self::Column;
    fn col_offload_cap() -> Self::Column;
    fn col_offload_task_id() -> Self::Column;
    /// Bucket column for features that stage an OffloadMQ input/output bucket
    /// (image analysis, nude detect, music gen). `None` for features without one
    /// (e.g. tts).
    fn col_bucket() -> Option<Self::Column> {
        None
    }
}

/// Fetch a single job scoped to its owner.
pub async fn get_job<E>(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<Option<E::Model>, AppError>
where
    E: OffloadJobEntity,
    E::Model: OffloadJobModel,
{
    E::find()
        .filter(E::col_id().eq(job_id))
        .filter(E::col_user_id().eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

/// List a user's jobs, newest first.
pub async fn list_jobs<E>(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<E::Model>, AppError>
where
    E: OffloadJobEntity,
    E::Model: OffloadJobModel,
{
    E::find()
        .filter(E::col_user_id().eq(user_id))
        .order_by_desc(E::col_created_at())
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Delete a job scoped to its owner. `NotFound` if nothing was removed.
pub async fn delete_job<E>(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<(), AppError>
where
    E: OffloadJobEntity,
    E::Model: OffloadJobModel,
{
    let result = E::delete_many()
        .filter(E::col_id().eq(job_id))
        .filter(E::col_user_id().eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// Update status/stage/error and bump `updated_at`.
pub async fn update_status<E>(
    db: &DatabaseConnection,
    job_id: i64,
    status: &str,
    stage: Option<&str>,
    error: Option<&str>,
) -> Result<(), AppError>
where
    E: OffloadJobEntity,
    E::Model: OffloadJobModel,
{
    let now = chrono::Utc::now().fixed_offset();
    E::update_many()
        .col_expr(E::col_status(), Expr::value(status.to_string()))
        .col_expr(E::col_stage(), Expr::value(stage.map(str::to_string)))
        .col_expr(E::col_error(), Expr::value(error.map(str::to_string)))
        .col_expr(E::col_updated_at(), Expr::value(now))
        .filter(E::col_id().eq(job_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// Record the linked OffloadMQ task (and optional bucket) and flip status to
/// `submitted`. Pass `bucket = None` for features without a bucket column.
pub async fn set_offload_task<E>(
    db: &DatabaseConnection,
    job_id: i64,
    offload_cap: &str,
    offload_task_id: &str,
    bucket: Option<&str>,
) -> Result<(), AppError>
where
    E: OffloadJobEntity,
    E::Model: OffloadJobModel,
{
    let now = chrono::Utc::now().fixed_offset();
    let mut query = E::update_many()
        .col_expr(E::col_status(), Expr::value("submitted".to_string()))
        .col_expr(E::col_offload_cap(), Expr::value(Some(offload_cap.to_string())))
        .col_expr(E::col_offload_task_id(), Expr::value(Some(offload_task_id.to_string())))
        .col_expr(E::col_updated_at(), Expr::value(now));
    if let (Some(col), Some(bucket)) = (E::col_bucket(), bucket) {
        query = query.col_expr(col, Expr::value(Some(bucket.to_string())));
    }
    query
        .filter(E::col_id().eq(job_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// All non-terminal jobs, oldest-touched first — the background worker's queue.
pub async fn list_jobs_for_background_worker<E>(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<E::Model>, AppError>
where
    E: OffloadJobEntity,
    E::Model: OffloadJobModel,
{
    E::find()
        .filter(
            Condition::any()
                .add(E::col_status().eq("submitted"))
                .add(E::col_status().eq("pending"))
                .add(E::col_status().eq("running"))
                .add(E::col_status().eq("cancelRequested")),
        )
        .order_by_asc(E::col_updated_at())
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}
