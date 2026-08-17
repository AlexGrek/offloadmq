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
    sea_query::Expr, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect,
};

use crate::{error::AppError, offload::task_status::WORKER_PICKUP_STATUSES};

/// Read access to the lifecycle fields every job model shares. Implemented on
/// each entity's `Model`.
pub trait OffloadJobModel {
    fn id(&self) -> i64;
    fn status(&self) -> &str;
    fn offload_cap(&self) -> Option<&str>;
    fn offload_task_id(&self) -> Option<&str>;
    /// The OffloadMQ bucket this job owns, if any — the value behind
    /// [`OffloadJobEntity::col_bucket`]. The generic driver releases it when the
    /// job reaches a terminal state, so a finished job never leaves a bucket
    /// behind for the server's TTL sweep to find. `None` for bucket-less
    /// features (tts).
    fn bucket_uid(&self) -> Option<&str> {
        None
    }
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

/// Mirrors [`crate::offload::task_status::is_terminal`], as a slice so it can be
/// pushed into a SQL `NOT IN`.
const TERMINAL_STATUSES: [&str; 3] = ["completed", "failed", "canceled"];

/// Mark long-abandoned non-terminal rows failed, returning how many were reaped.
///
/// Rows strand outside every worker's pickup set: a pod restart between the row
/// insert and the OffloadMQ submit leaves a job `created`/`queued` with no task
/// id, and the pickup queries below only match rows that were actually
/// submitted. Nothing revisits them, so without a reaper they stay non-terminal
/// forever and keep rendering as in-flight in the UI.
///
/// Takes columns explicitly rather than via [`OffloadJobEntity`] so the bespoke
/// job tables (image generation, movie, llm compare/debate) can reuse it.
pub async fn fail_stale_rows<E>(
    db: &DatabaseConnection,
    status_col: E::Column,
    updated_at_col: E::Column,
    error_col: E::Column,
    cutoff: chrono::DateTime<chrono::FixedOffset>,
    reason: &str,
) -> Result<u64, AppError>
where
    E: EntityTrait,
{
    let now = chrono::Utc::now().fixed_offset();
    let result = E::update_many()
        .col_expr(status_col, Expr::value("failed".to_string()))
        .col_expr(error_col, Expr::value(Some(reason.to_string())))
        .col_expr(updated_at_col, Expr::value(now))
        .filter(status_col.is_not_in(TERMINAL_STATUSES.map(str::to_string)))
        .filter(updated_at_col.lt(cutoff))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(result.rows_affected)
}

/// [`fail_stale_rows`] for entities already on the offload-job framework.
pub async fn fail_stale_jobs<E>(
    db: &DatabaseConnection,
    cutoff: chrono::DateTime<chrono::FixedOffset>,
    reason: &str,
) -> Result<u64, AppError>
where
    E: OffloadJobEntity,
    E::Model: OffloadJobModel,
{
    fail_stale_rows::<E>(
        db,
        E::col_status(),
        E::col_updated_at(),
        E::col_error(),
        cutoff,
        reason,
    )
    .await
}

/// All non-terminal jobs, oldest-touched first — the background worker's queue.
///
/// The status set must be [`WORKER_PICKUP_STATUSES`] and nothing narrower: a poll
/// writes the upstream OffloadMQ status into the row verbatim, so a job caught
/// mid-flight sits at `queued` / `assigned` / `starting` just as often as at
/// `running`. Listing only a subset silently orphans those rows — the worker
/// stops picking them up, and only a foreground poll (which fetches by id) can
/// still finish them, i.e. the job completes only while its page is open.
pub async fn list_jobs_for_background_worker<E>(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<E::Model>, AppError>
where
    E: OffloadJobEntity,
    E::Model: OffloadJobModel,
{
    E::find()
        .filter(E::col_status().is_in(WORKER_PICKUP_STATUSES.map(str::to_string)))
        .order_by_asc(E::col_updated_at())
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}
