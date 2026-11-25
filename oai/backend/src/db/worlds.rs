//! VR Worlds job persistence. Lifecycle columns are handled generically via
//! [`crate::db::offload_jobs`]; only `create_job`, the progress/result writes and
//! the framework trait impls live here.

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, sea_query::Expr,
};

use crate::{
    db::{
        entities::world_jobs::{self, Entity as WorldJobEntity},
        offload_jobs::{OffloadJobEntity, OffloadJobModel},
    },
    error::AppError,
};

pub type WorldJob = world_jobs::Model;

impl OffloadJobModel for world_jobs::Model {
    fn id(&self) -> i64 {
        self.id
    }
    fn status(&self) -> &str {
        &self.status
    }
    fn offload_cap(&self) -> Option<&str> {
        self.offload_cap.as_deref()
    }
    fn offload_task_id(&self) -> Option<&str> {
        self.offload_task_id.as_deref()
    }
    fn bucket_uid(&self) -> Option<&str> {
        self.output_bucket_uid.as_deref()
    }
}

impl OffloadJobEntity for WorldJobEntity {
    fn col_id() -> Self::Column {
        world_jobs::Column::Id
    }
    fn col_user_id() -> Self::Column {
        world_jobs::Column::UserId
    }
    fn col_status() -> Self::Column {
        world_jobs::Column::Status
    }
    fn col_stage() -> Self::Column {
        world_jobs::Column::Stage
    }
    fn col_error() -> Self::Column {
        world_jobs::Column::Error
    }
    fn col_created_at() -> Self::Column {
        world_jobs::Column::CreatedAt
    }
    fn col_updated_at() -> Self::Column {
        world_jobs::Column::UpdatedAt
    }
    fn col_offload_cap() -> Self::Column {
        world_jobs::Column::OffloadCap
    }
    fn col_offload_task_id() -> Self::Column {
        world_jobs::Column::OffloadTaskId
    }
    fn col_bucket() -> Option<Self::Column> {
        Some(world_jobs::Column::OutputBucketUid)
    }
}

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub capability: &'a str,
    pub mode: &'a str,
    pub params_json: &'a str,
    pub input_image_id: i64,
}

pub async fn create_job(db: &DatabaseConnection, input: NewJobInput<'_>) -> Result<WorldJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    world_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        capability: ActiveValue::Set(input.capability.to_string()),
        mode: ActiveValue::Set(input.mode.to_string()),
        params_json: ActiveValue::Set(input.params_json.to_string()),
        input_image_id: ActiveValue::Set(Some(input.input_image_id)),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        output_bucket_uid: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
        result_json: ActiveValue::Set(None),
        ply_path: ActiveValue::Set(None),
        preview_path: ActiveValue::Set(None),
        ply_bytes: ActiveValue::Set(None),
        started_at: ActiveValue::Set(None),
        typical_runtime_seconds: ActiveValue::Set(None),
    }
    .insert(db)
    .await
    .map_err(AppError::Database)
}

/// Capabilities of the user's last `limit` worlds, newest first — the "most used"
/// ranking of the generator picker.
pub async fn recent_job_capabilities(db: &DatabaseConnection, user_id: i64, limit: u64) -> Result<Vec<String>, AppError> {
    WorldJobEntity::find()
        .select_only()
        .column(world_jobs::Column::Capability)
        .filter(world_jobs::Column::UserId.eq(user_id))
        .order_by_desc(world_jobs::Column::CreatedAt)
        .limit(limit)
        .into_tuple::<String>()
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// The user's in-flight jobs, newest first — the Progress drawer's feed.
pub async fn list_user_active(db: &DatabaseConnection, user_id: i64) -> Result<Vec<WorldJob>, AppError> {
    WorldJobEntity::find()
        .filter(world_jobs::Column::UserId.eq(user_id))
        .filter(world_jobs::Column::Status.is_not_in(["completed", "failed", "canceled"]))
        .order_by_desc(world_jobs::Column::CreatedAt)
        .limit(64)
        .all(db)
        .await
        .map_err(AppError::Database)
}

/// Progress-bar inputs observed on a poll. `started_at` is set once (the
/// `IS NULL` filter) so it keeps the moment the agent actually began work.
pub async fn record_progress(
    db: &DatabaseConnection,
    job_id: i64,
    executing: bool,
    typical_runtime_seconds: Option<f64>,
) -> Result<(), AppError> {
    if executing {
        WorldJobEntity::update_many()
            .col_expr(world_jobs::Column::StartedAt, Expr::value(chrono::Utc::now().fixed_offset()))
            .filter(world_jobs::Column::Id.eq(job_id))
            .filter(world_jobs::Column::StartedAt.is_null())
            .exec(db)
            .await
            .map_err(AppError::Database)?;
    }
    if let Some(secs) = typical_runtime_seconds.filter(|s| *s > 0.0) {
        WorldJobEntity::update_many()
            .col_expr(world_jobs::Column::TypicalRuntimeSeconds, Expr::value(secs))
            .filter(world_jobs::Column::Id.eq(job_id))
            .exec(db)
            .await
            .map_err(AppError::Database)?;
    }
    Ok(())
}

pub struct WorldResult<'a> {
    pub result_json: &'a str,
    pub ply_path: &'a str,
    pub preview_path: Option<&'a str>,
    pub ply_bytes: i64,
}

/// Attach the stored world and flip the job to `completed`.
pub async fn set_result(db: &DatabaseConnection, job_id: i64, r: WorldResult<'_>) -> Result<(), AppError> {
    world_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("completed".to_string()),
        result_json: ActiveValue::Set(Some(r.result_json.to_string())),
        ply_path: ActiveValue::Set(Some(r.ply_path.to_string())),
        preview_path: ActiveValue::Set(r.preview_path.map(str::to_string)),
        ply_bytes: ActiveValue::Set(Some(r.ply_bytes)),
        error: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(chrono::Utc::now().fixed_offset()),
        ..Default::default()
    }
    .update(db)
    .await
    .map_err(AppError::Database)?;
    Ok(())
}
