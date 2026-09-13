use std::collections::HashMap;

use sea_orm::{
    sea_query::{Condition, Expr, ExprTrait, Order, Query},
    ActiveModelTrait, ActiveValue, ColumnTrait, ConnectionTrait, DatabaseConnection, EntityTrait,
    FromQueryResult, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};

use crate::{
    db::entities::{
        image_files::{self, Entity as ImageFileEntity},
        image_generation_jobs::{self, Entity as ImageGenerationJobEntity},
        image_offload_tasks::{self, Entity as ImageOffloadTaskEntity},
        image_pipeline_events::{self, Entity as ImagePipelineEventEntity},
    },
    error::AppError,
    offload::task_status,
};

pub type ImageGenerationJob = image_generation_jobs::Model;
pub type ImageFile = image_files::Model;
pub type ImagePipelineEvent = image_pipeline_events::Model;
pub type ImageOffloadTask = image_offload_tasks::Model;

pub struct NewJobInput<'a> {
    pub id: i64,
    pub display_name: &'a str,
    pub user_id: i64,
    pub prompt: &'a str,
    pub negative_prompt: Option<&'a str>,
    pub capability: &'a str,
    pub workflow: &'a str,
    pub width: i32,
    pub height: i32,
    pub seed: Option<i64>,
    pub input_image_id: Option<i64>,
    pub pipeline_params_json: &'a str,
}

pub struct NewImageFileInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub job_id: Option<i64>,
    pub direction: &'a str,
    pub source: &'a str,
    pub storage_path: &'a str,
    pub thumbnail_storage_path: &'a str,
    pub thumbnail_stored_bytes: i64,
    pub filename: &'a str,
    pub content_type: &'a str,
    pub original_bytes: Option<i64>,
    pub stored_bytes: i64,
    pub original_width: Option<i32>,
    pub original_height: Option<i32>,
    pub stored_width: i32,
    pub stored_height: i32,
    pub exif_orientation: Option<i32>,
    pub rescaled: bool,
    pub reencoded: bool,
    pub sha256: &'a str,
    pub offload_bucket_uid: Option<&'a str>,
    pub offload_file_uid: Option<&'a str>,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<ImageGenerationJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_generation_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        display_name: ActiveValue::Set(input.display_name.to_string()),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        prompt: ActiveValue::Set(input.prompt.to_string()),
        negative_prompt: ActiveValue::Set(input.negative_prompt.map(str::to_string)),
        capability: ActiveValue::Set(input.capability.to_string()),
        workflow: ActiveValue::Set(input.workflow.to_string()),
        width: ActiveValue::Set(input.width),
        height: ActiveValue::Set(input.height),
        seed: ActiveValue::Set(input.seed),
        input_image_id: ActiveValue::Set(input.input_image_id),
        error: ActiveValue::Set(None),
        pipeline_params_json: ActiveValue::Set(input.pipeline_params_json.to_string()),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn get_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<Option<ImageGenerationJob>, AppError> {
    ImageGenerationJobEntity::find_by_id(job_id)
        .filter(image_generation_jobs::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_jobs(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<ImageGenerationJob>, AppError> {
    ImageGenerationJobEntity::find()
        .filter(image_generation_jobs::Column::UserId.eq(user_id))
        .order_by_desc(image_generation_jobs::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Capabilities of the user's most recent jobs, newest first.
///
/// Only that one column is read: the usage tally behind the model picker does
/// not need the prompts and pipeline JSON that the full rows carry.
pub async fn recent_job_capabilities(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<String>, AppError> {
    ImageGenerationJobEntity::find()
        .select_only()
        .column(image_generation_jobs::Column::Capability)
        .filter(image_generation_jobs::Column::UserId.eq(user_id))
        .order_by_desc(image_generation_jobs::Column::CreatedAt)
        .limit(limit)
        .into_tuple::<String>()
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn delete_job(
    db: &DatabaseConnection,
    job_id: i64,
    user_id: i64,
) -> Result<(), AppError> {
    let result = ImageGenerationJobEntity::delete_many()
        .filter(image_generation_jobs::Column::Id.eq(job_id))
        .filter(image_generation_jobs::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn update_job_status(
    db: &DatabaseConnection,
    job_id: i64,
    status: &str,
    error: Option<&str>,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_generation_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set(status.to_string()),
        updated_at: ActiveValue::Set(now),
        error: ActiveValue::Set(error.map(str::to_string)),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn create_pipeline_event(
    db: &DatabaseConnection,
    id: i64,
    job_id: i64,
    step: &str,
    state: &str,
    details: Option<&str>,
) -> Result<ImagePipelineEvent, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_pipeline_events::ActiveModel {
        id: ActiveValue::Set(id),
        job_id: ActiveValue::Set(job_id),
        step: ActiveValue::Set(step.to_string()),
        state: ActiveValue::Set(state.to_string()),
        details: ActiveValue::Set(details.map(str::to_string)),
        created_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn list_pipeline_events(
    db: &DatabaseConnection,
    job_id: i64,
) -> Result<Vec<ImagePipelineEvent>, AppError> {
    ImagePipelineEventEntity::find()
        .filter(image_pipeline_events::Column::JobId.eq(job_id))
        .order_by_asc(image_pipeline_events::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Count of failed reconcile attempts recorded for a job, used to cap the
/// background worker's forever-retry on a job whose output never downloads.
pub async fn count_reconcile_failures(db: &DatabaseConnection, job_id: i64) -> Result<u64, AppError> {
    ImagePipelineEventEntity::find()
        .filter(image_pipeline_events::Column::JobId.eq(job_id))
        .filter(image_pipeline_events::Column::Step.eq("download.reconcile"))
        .filter(image_pipeline_events::Column::State.eq("error"))
        .count(db)
        .await
        .map_err(AppError::Database)
}

#[derive(FromQueryResult)]
struct JobIdRow {
    job_id: i64,
}

/// Finds up to `job_batch` job ids whose pipeline-event count exceeds `keep`,
/// worst offenders first. Used by the periodic events cleanup pass.
pub async fn jobs_with_excess_pipeline_events(
    db: &DatabaseConnection,
    keep: u64,
    job_batch: u64,
) -> Result<Vec<i64>, AppError> {
    let event_count = Expr::col(image_pipeline_events::Column::Id).count();
    let stmt = Query::select()
        .column(image_pipeline_events::Column::JobId)
        .from(ImagePipelineEventEntity)
        .group_by_col(image_pipeline_events::Column::JobId)
        .and_having(event_count.clone().gt(keep))
        .order_by_expr(event_count, Order::Desc)
        .limit(job_batch)
        .to_owned();

    let rows =
        JobIdRow::find_by_statement(db.get_database_backend().build(&stmt)).all(db).await.map_err(AppError::Database)?;
    Ok(rows.into_iter().map(|r| r.job_id).collect())
}

/// Deletes all but the most recent `keep` pipeline events for one job. Returns
/// the number of rows deleted.
pub async fn prune_pipeline_events_for_job(
    db: &DatabaseConnection,
    job_id: i64,
    keep: u64,
) -> Result<u64, AppError> {
    let keep_ids = Query::select()
        .column(image_pipeline_events::Column::Id)
        .from(ImagePipelineEventEntity)
        .and_where(image_pipeline_events::Column::JobId.eq(job_id))
        .order_by(image_pipeline_events::Column::CreatedAt, Order::Desc)
        .order_by(image_pipeline_events::Column::Id, Order::Desc)
        .limit(keep)
        .to_owned();

    let result = ImagePipelineEventEntity::delete_many()
        .filter(image_pipeline_events::Column::JobId.eq(job_id))
        .filter(Expr::col(image_pipeline_events::Column::Id).not_in_subquery(keep_ids))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(result.rows_affected)
}

pub async fn create_offload_task(
    db: &DatabaseConnection,
    id: i64,
    job_id: i64,
    offload_cap: &str,
    offload_task_id: &str,
    submit_payload: &str,
) -> Result<ImageOffloadTask, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_offload_tasks::ActiveModel {
        id: ActiveValue::Set(id),
        job_id: ActiveValue::Set(job_id),
        offload_cap: ActiveValue::Set(offload_cap.to_string()),
        offload_task_id: ActiveValue::Set(offload_task_id.to_string()),
        submit_payload: ActiveValue::Set(submit_payload.to_string()),
        last_poll_status: ActiveValue::Set(None),
        last_poll_stage: ActiveValue::Set(None),
        last_poll_log: ActiveValue::Set(None),
        last_poll_output: ActiveValue::Set(None),
        submitted_at: ActiveValue::Set(now),
        started_at: ActiveValue::Set(None),
        finished_at: ActiveValue::Set(None),
        typical_runtime_seconds: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

/// Repoint a job's offload task row at a newly submitted task, clearing every
/// poll and timing field.
///
/// Used when an external-resize pre-step completes and the real task takes over.
/// The row is *replaced* rather than a second one inserted because
/// [`get_offload_task_by_job`] assumes one row per job — and because the progress
/// bar should measure the task actually running now, not the finished pre-step.
pub async fn replace_offload_task(
    db: &DatabaseConnection,
    task_id: i64,
    offload_cap: &str,
    offload_task_id: &str,
    submit_payload: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_offload_tasks::ActiveModel {
        id: ActiveValue::Set(task_id),
        offload_cap: ActiveValue::Set(offload_cap.to_string()),
        offload_task_id: ActiveValue::Set(offload_task_id.to_string()),
        submit_payload: ActiveValue::Set(submit_payload.to_string()),
        last_poll_status: ActiveValue::Set(None),
        last_poll_stage: ActiveValue::Set(None),
        last_poll_log: ActiveValue::Set(None),
        last_poll_output: ActiveValue::Set(None),
        submitted_at: ActiveValue::Set(now),
        started_at: ActiveValue::Set(None),
        finished_at: ActiveValue::Set(None),
        typical_runtime_seconds: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

/// Active image jobs for a user plus their linked OffloadMQ task rows (debug panel).
/// Non-terminal jobs that carry an offload task, for the progress drawer.
///
/// The terminal-status filter runs in SQL rather than in Rust: the newest rows
/// are overwhelmingly completed, so filtering afterwards spent the whole 64-row
/// window on jobs that were then discarded. The offload tasks are fetched in one
/// batched query instead of one per job.
pub async fn list_user_active_offload_tasks(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<Vec<(ImageGenerationJob, ImageOffloadTask)>, AppError> {
    let jobs = ImageGenerationJobEntity::find()
        .filter(image_generation_jobs::Column::UserId.eq(user_id))
        .filter(
            image_generation_jobs::Column::Status
                .is_not_in(["completed", "failed", "canceled"]),
        )
        .order_by_desc(image_generation_jobs::Column::CreatedAt)
        .limit(64)
        .all(db)
        .await
        .map_err(AppError::Database)?;
    if jobs.is_empty() {
        return Ok(Vec::new());
    }

    let job_ids: Vec<i64> = jobs.iter().map(|j| j.id).collect();
    let mut tasks_by_job: HashMap<i64, ImageOffloadTask> =
        list_offload_tasks_for_jobs(db, &job_ids)
            .await?
            .into_iter()
            .map(|t| (t.job_id, t))
            .collect();

    Ok(jobs
        .into_iter()
        .filter_map(|job| tasks_by_job.remove(&job.id).map(|task| (job, task)))
        .collect())
}

pub async fn get_offload_task_by_job(
    db: &DatabaseConnection,
    job_id: i64,
) -> Result<Option<ImageOffloadTask>, AppError> {
    ImageOffloadTaskEntity::find()
        .filter(image_offload_tasks::Column::JobId.eq(job_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn update_offload_task_poll(
    db: &DatabaseConnection,
    id: i64,
    status: Option<&str>,
    stage: Option<&str>,
    log: Option<&str>,
    output: Option<&str>,
    typical_runtime_seconds: Option<f64>,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let mut model = image_offload_tasks::ActiveModel {
        id: ActiveValue::Set(id),
        last_poll_status: ActiveValue::Set(status.map(str::to_string)),
        last_poll_stage: ActiveValue::Set(stage.map(str::to_string)),
        last_poll_log: ActiveValue::Set(log.map(str::to_string)),
        last_poll_output: ActiveValue::Set(output.map(str::to_string)),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    if let Some(secs) = typical_runtime_seconds.filter(|s| *s > 0.0) {
        model.typical_runtime_seconds = ActiveValue::Set(Some(secs));
    }
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

/// Stamp `started_at = now` the first time a task is observed executing on an
/// agent. The `IS NULL` filter makes this set-once and idempotent across polls.
pub async fn mark_offload_task_started(
    db: &DatabaseConnection,
    id: i64,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    ImageOffloadTaskEntity::update_many()
        .col_expr(image_offload_tasks::Column::StartedAt, Expr::value(now))
        .filter(image_offload_tasks::Column::Id.eq(id))
        .filter(image_offload_tasks::Column::StartedAt.is_null())
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

/// Stamp `finished_at = now` the first time a task is observed in a terminal
/// status. The `IS NULL` filter makes this set-once and idempotent across polls.
pub async fn mark_offload_task_finished(
    db: &DatabaseConnection,
    id: i64,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    ImageOffloadTaskEntity::update_many()
        .col_expr(image_offload_tasks::Column::FinishedAt, Expr::value(now))
        .filter(image_offload_tasks::Column::Id.eq(id))
        .filter(image_offload_tasks::Column::FinishedAt.is_null())
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    Ok(())
}

pub async fn create_image_file(
    db: &DatabaseConnection,
    input: NewImageFileInput<'_>,
) -> Result<ImageFile, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = image_files::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        job_id: ActiveValue::Set(input.job_id),
        direction: ActiveValue::Set(input.direction.to_string()),
        source: ActiveValue::Set(input.source.to_string()),
        storage_path: ActiveValue::Set(input.storage_path.to_string()),
        thumbnail_storage_path: ActiveValue::Set(Some(input.thumbnail_storage_path.to_string())),
        thumbnail_stored_bytes: ActiveValue::Set(input.thumbnail_stored_bytes),
        filename: ActiveValue::Set(input.filename.to_string()),
        content_type: ActiveValue::Set(input.content_type.to_string()),
        original_bytes: ActiveValue::Set(input.original_bytes),
        stored_bytes: ActiveValue::Set(input.stored_bytes),
        original_width: ActiveValue::Set(input.original_width),
        original_height: ActiveValue::Set(input.original_height),
        stored_width: ActiveValue::Set(input.stored_width),
        stored_height: ActiveValue::Set(input.stored_height),
        exif_orientation: ActiveValue::Set(input.exif_orientation),
        rescaled: ActiveValue::Set(input.rescaled),
        reencoded: ActiveValue::Set(input.reencoded),
        sha256: ActiveValue::Set(input.sha256.to_string()),
        offload_bucket_uid: ActiveValue::Set(input.offload_bucket_uid.map(str::to_string)),
        offload_file_uid: ActiveValue::Set(input.offload_file_uid.map(str::to_string)),
        created_at: ActiveValue::Set(now),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn list_job_files(db: &DatabaseConnection, job_id: i64) -> Result<Vec<ImageFile>, AppError> {
    ImageFileEntity::find()
        .filter(image_files::Column::JobId.eq(job_id))
        .order_by_asc(image_files::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Batched sibling of [`list_job_files`] — one query for every job in `job_ids`
/// instead of one query per job, for building a job list detail response.
pub async fn list_job_files_for_jobs(
    db: &DatabaseConnection,
    job_ids: &[i64],
) -> Result<Vec<ImageFile>, AppError> {
    ImageFileEntity::find()
        .filter(image_files::Column::JobId.is_in(job_ids.iter().copied()))
        .order_by_asc(image_files::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Batched sibling of [`list_pipeline_events`] — one query for every job in
/// `job_ids` instead of one query per job.
pub async fn list_pipeline_events_for_jobs(
    db: &DatabaseConnection,
    job_ids: &[i64],
) -> Result<Vec<ImagePipelineEvent>, AppError> {
    ImagePipelineEventEntity::find()
        .filter(image_pipeline_events::Column::JobId.is_in(job_ids.iter().copied()))
        .order_by_asc(image_pipeline_events::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Batched sibling of [`get_offload_task_by_job`] — one query for every job in
/// `job_ids` instead of one query per job.
pub async fn list_offload_tasks_for_jobs(
    db: &DatabaseConnection,
    job_ids: &[i64],
) -> Result<Vec<ImageOffloadTask>, AppError> {
    ImageOffloadTaskEntity::find()
        .filter(image_offload_tasks::Column::JobId.is_in(job_ids.iter().copied()))
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn get_image_file(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
) -> Result<Option<ImageFile>, AppError> {
    ImageFileEntity::find_by_id(id)
        .filter(image_files::Column::UserId.eq(user_id))
        .one(db)
        .await
        .map_err(AppError::Database)
}

pub async fn set_image_thumbnail_meta(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    thumbnail_storage_path: &str,
    thumbnail_stored_bytes: i64,
) -> Result<(), AppError> {
    let file = get_image_file(db, id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut active: image_files::ActiveModel = file.into();
    active.thumbnail_storage_path = ActiveValue::Set(Some(thumbnail_storage_path.to_string()));
    active.thumbnail_stored_bytes = ActiveValue::Set(thumbnail_stored_bytes);
    active.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

pub async fn delete_image_file(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
) -> Result<(), AppError> {
    let result = ImageFileEntity::delete_many()
        .filter(image_files::Column::Id.eq(id))
        .filter(image_files::Column::UserId.eq(user_id))
        .exec(db)
        .await
        .map_err(AppError::Database)?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn set_image_file_job(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    job_id: i64,
) -> Result<(), AppError> {
    let file = get_image_file(db, id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let mut active: image_files::ActiveModel = file.into();
    active.job_id = ActiveValue::Set(Some(job_id));
    active.update(db).await.map_err(AppError::Database)?;
    Ok(())
}

/// The pipeline worker's queue: every in-flight job (any status a poll can leave
/// behind — see `WORKER_PICKUP_STATUSES`), plus the pipeline-local `created` and
/// the `completed` rows re-checked for missing output files.
/// Jobs the background worker still has work to do on, oldest first.
///
/// A `completed` job is only in scope while its output is missing — that is the
/// reconcile case. Including every completed job instead deadlocked the worker:
/// the pass is `ORDER BY updated_at ASC LIMIT n`, and reconciling a job that
/// already has its output is a no-op that never touches `updated_at`, so the
/// oldest such jobs held the front of the queue permanently and no job behind
/// them was ever picked up again.
pub async fn list_jobs_for_background_worker(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImageGenerationJob>, AppError> {
    let in_flight: Vec<String> = task_status::WORKER_PICKUP_STATUSES
        .iter()
        .chain(["created"].iter())
        .map(|s| s.to_string())
        .collect();

    // `job_id IS NOT NULL` is load-bearing: uploads and img-utils outputs carry a
    // NULL job_id, and a NULL anywhere in a NOT IN list makes the whole predicate
    // never true — which would exclude every completed job instead of just the
    // ones already holding an output.
    let jobs_with_output = Query::select()
        .column(image_files::Column::JobId)
        .from(ImageFileEntity)
        .and_where(image_files::Column::Direction.eq("output"))
        .and_where(image_files::Column::JobId.is_not_null())
        .to_owned();

    let needs_work = Condition::any()
        .add(image_generation_jobs::Column::Status.is_in(in_flight))
        .add(
            Condition::all()
                .add(image_generation_jobs::Column::Status.eq("completed"))
                .add(
                    Expr::col(image_generation_jobs::Column::Id)
                        .not_in_subquery(jobs_with_output),
                ),
        );

    ImageGenerationJobEntity::find()
        .filter(needs_work)
        .order_by_asc(image_generation_jobs::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_jobs_global(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImageGenerationJob>, AppError> {
    ImageGenerationJobEntity::find()
        .order_by_desc(image_generation_jobs::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn get_job_global(
    db: &DatabaseConnection,
    job_id: i64,
) -> Result<Option<ImageGenerationJob>, AppError> {
    ImageGenerationJobEntity::find_by_id(job_id)
        .one(db)
        .await
        .map_err(AppError::Database)
}

/// All files owned by a user, newest first — backs the user file browser.
pub async fn list_user_image_files(
    db: &DatabaseConnection,
    user_id: i64,
    limit: u64,
) -> Result<Vec<ImageFile>, AppError> {
    ImageFileEntity::find()
        .filter(image_files::Column::UserId.eq(user_id))
        .order_by_desc(image_files::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Sum of `stored_bytes` across all of a user's files — the source of truth for
/// the cached `users.used_storage_bytes` value.
pub async fn sum_user_stored_bytes(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<i64, AppError> {
    let rows: Vec<(i64, i64)> = ImageFileEntity::find()
        .select_only()
        .column(image_files::Column::StoredBytes)
        .column(image_files::Column::ThumbnailStoredBytes)
        .filter(image_files::Column::UserId.eq(user_id))
        .into_tuple()
        .all(db)
        .await
        .map_err(AppError::Database)?;
    Ok(rows.iter().map(|(main, thumb)| main + thumb).sum())
}

pub async fn list_image_files_global(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImageFile>, AppError> {
    ImageFileEntity::find()
        .order_by_desc(image_files::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_pipeline_events_global(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImagePipelineEvent>, AppError> {
    ImagePipelineEventEntity::find()
        .order_by_desc(image_pipeline_events::Column::CreatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn list_offload_tasks_global(
    db: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<ImageOffloadTask>, AppError> {
    ImageOffloadTaskEntity::find()
        .order_by_desc(image_offload_tasks::Column::UpdatedAt)
        .limit(limit)
        .all(db)
        .await
        .map_err(AppError::Database)
}
