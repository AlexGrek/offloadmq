//! Background-remover job persistence. Lifecycle columns are handled generically
//! via [`crate::db::offload_jobs`]; only the feature-specific writes (`create_job`,
//! `set_output_image`, `record_progress`) and the framework trait impls live here.

use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect, sea_query::Expr,
};

use crate::{
    db::{
        entities::bg_remover_jobs::{self, Entity as BgRemoverJobEntity},
        offload_jobs::{OffloadJobEntity, OffloadJobModel},
    },
    error::AppError,
};

pub type BgRemoverJob = bg_remover_jobs::Model;

impl OffloadJobModel for bg_remover_jobs::Model {
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

impl OffloadJobEntity for BgRemoverJobEntity {
    fn col_id() -> Self::Column {
        bg_remover_jobs::Column::Id
    }
    fn col_user_id() -> Self::Column {
        bg_remover_jobs::Column::UserId
    }
    fn col_status() -> Self::Column {
        bg_remover_jobs::Column::Status
    }
    fn col_stage() -> Self::Column {
        bg_remover_jobs::Column::Stage
    }
    fn col_error() -> Self::Column {
        bg_remover_jobs::Column::Error
    }
    fn col_created_at() -> Self::Column {
        bg_remover_jobs::Column::CreatedAt
    }
    fn col_updated_at() -> Self::Column {
        bg_remover_jobs::Column::UpdatedAt
    }
    fn col_offload_cap() -> Self::Column {
        bg_remover_jobs::Column::OffloadCap
    }
    fn col_offload_task_id() -> Self::Column {
        bg_remover_jobs::Column::OffloadTaskId
    }
    fn col_bucket() -> Option<Self::Column> {
        Some(bg_remover_jobs::Column::OutputBucketUid)
    }
}

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub capability: &'a str,
    pub input_image_id: Option<i64>,
    pub options_json: Option<&'a str>,
}

/// The user's in-flight jobs, newest first — the Progress drawer's feed.
pub async fn list_user_active(
    db: &DatabaseConnection,
    user_id: i64,
) -> Result<Vec<BgRemoverJob>, AppError> {
    BgRemoverJobEntity::find()
        .filter(bg_remover_jobs::Column::UserId.eq(user_id))
        .filter(bg_remover_jobs::Column::Status.is_not_in(["completed", "failed", "canceled"]))
        .order_by_desc(bg_remover_jobs::Column::CreatedAt)
        .limit(64)
        .all(db)
        .await
        .map_err(AppError::Database)
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<BgRemoverJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = bg_remover_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        capability: ActiveValue::Set(input.capability.to_string()),
        input_image_id: ActiveValue::Set(input.input_image_id),
        options_json: ActiveValue::Set(input.options_json.map(str::to_string)),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        output_bucket_uid: ActiveValue::Set(None),
        output_image_id: ActiveValue::Set(None),
        foreground_ratio: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
        started_at: ActiveValue::Set(None),
        typical_runtime_seconds: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

/// Record progress-bar inputs observed on a poll.
///
/// `started_at` is set-once via the `IS NULL` filter, so it keeps the moment the
/// agent actually began work even though every later poll calls this again.
/// `typical_runtime_seconds` is refreshed whenever the server reports one.
pub async fn record_progress(
    db: &DatabaseConnection,
    job_id: i64,
    executing: bool,
    typical_runtime_seconds: Option<f64>,
) -> Result<(), AppError> {
    if executing {
        let now = chrono::Utc::now().fixed_offset();
        BgRemoverJobEntity::update_many()
            .col_expr(bg_remover_jobs::Column::StartedAt, Expr::value(now))
            .filter(bg_remover_jobs::Column::Id.eq(job_id))
            .filter(bg_remover_jobs::Column::StartedAt.is_null())
            .exec(db)
            .await
            .map_err(AppError::Database)?;
    }
    if let Some(secs) = typical_runtime_seconds.filter(|s| *s > 0.0) {
        BgRemoverJobEntity::update_many()
            .col_expr(
                bg_remover_jobs::Column::TypicalRuntimeSeconds,
                Expr::value(secs),
            )
            .filter(bg_remover_jobs::Column::Id.eq(job_id))
            .exec(db)
            .await
            .map_err(AppError::Database)?;
    }
    Ok(())
}

/// Attach the produced cutout and flip the job to `completed`.
pub async fn set_output_image(
    db: &DatabaseConnection,
    job_id: i64,
    output_image_id: i64,
    foreground_ratio: Option<f64>,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = bg_remover_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("completed".to_string()),
        output_image_id: ActiveValue::Set(Some(output_image_id)),
        foreground_ratio: ActiveValue::Set(foreground_ratio),
        error: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}
