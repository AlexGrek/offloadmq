//! NudeNet detection job persistence. Lifecycle columns are handled generically
//! via [`crate::db::offload_jobs`]; only the detection-specific writes
//! (`create_job`, `set_result`) and the framework trait impls live here.

use sea_orm::{ActiveModelTrait, ActiveValue, DatabaseConnection};

use crate::{
    db::{
        entities::nude_detect_jobs::{self, Entity as NudeDetectJobEntity},
        offload_jobs::{OffloadJobEntity, OffloadJobModel},
    },
    error::AppError,
};

pub type NudeDetectJob = nude_detect_jobs::Model;

impl OffloadJobModel for nude_detect_jobs::Model {
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
}

impl OffloadJobEntity for NudeDetectJobEntity {
    fn col_id() -> Self::Column {
        nude_detect_jobs::Column::Id
    }
    fn col_user_id() -> Self::Column {
        nude_detect_jobs::Column::UserId
    }
    fn col_status() -> Self::Column {
        nude_detect_jobs::Column::Status
    }
    fn col_stage() -> Self::Column {
        nude_detect_jobs::Column::Stage
    }
    fn col_error() -> Self::Column {
        nude_detect_jobs::Column::Error
    }
    fn col_created_at() -> Self::Column {
        nude_detect_jobs::Column::CreatedAt
    }
    fn col_updated_at() -> Self::Column {
        nude_detect_jobs::Column::UpdatedAt
    }
    fn col_offload_cap() -> Self::Column {
        nude_detect_jobs::Column::OffloadCap
    }
    fn col_offload_task_id() -> Self::Column {
        nude_detect_jobs::Column::OffloadTaskId
    }
    fn col_bucket() -> Option<Self::Column> {
        Some(nude_detect_jobs::Column::OffloadBucketUid)
    }
}

pub struct NewJobInput {
    pub id: i64,
    pub user_id: i64,
    pub threshold: f64,
    pub input_image_id: Option<i64>,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput,
) -> Result<NudeDetectJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = nude_detect_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        threshold: ActiveValue::Set(input.threshold),
        input_image_id: ActiveValue::Set(input.input_image_id),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        offload_bucket_uid: ActiveValue::Set(None),
        result: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn set_result(
    db: &DatabaseConnection,
    job_id: i64,
    result: &str,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = nude_detect_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("completed".to_string()),
        result: ActiveValue::Set(Some(result.to_string())),
        error: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}
