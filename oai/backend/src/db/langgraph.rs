use sea_orm::{ActiveModelTrait, ActiveValue, DatabaseConnection};

use crate::{
    db::{
        entities::langgraph_jobs::{self, Entity as LanggraphJobEntity},
        offload_jobs::{OffloadJobEntity, OffloadJobModel},
    },
    error::AppError,
};

pub type LanggraphJob = langgraph_jobs::Model;

impl OffloadJobModel for langgraph_jobs::Model {
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
        self.offload_bucket_uid.as_deref()
    }
}

impl OffloadJobEntity for LanggraphJobEntity {
    fn col_bucket() -> Option<Self::Column> {
        Some(langgraph_jobs::Column::OffloadBucketUid)
    }
    fn col_id() -> Self::Column {
        langgraph_jobs::Column::Id
    }
    fn col_user_id() -> Self::Column {
        langgraph_jobs::Column::UserId
    }
    fn col_status() -> Self::Column {
        langgraph_jobs::Column::Status
    }
    fn col_stage() -> Self::Column {
        langgraph_jobs::Column::Stage
    }
    fn col_error() -> Self::Column {
        langgraph_jobs::Column::Error
    }
    fn col_created_at() -> Self::Column {
        langgraph_jobs::Column::CreatedAt
    }
    fn col_updated_at() -> Self::Column {
        langgraph_jobs::Column::UpdatedAt
    }
    fn col_offload_cap() -> Self::Column {
        langgraph_jobs::Column::OffloadCap
    }
    fn col_offload_task_id() -> Self::Column {
        langgraph_jobs::Column::OffloadTaskId
    }
}

pub async fn create_job(
    db: &DatabaseConnection,
    id: i64,
    user_id: i64,
    capability: &str,
    prompt: &str,
    request_json: String,
) -> Result<LanggraphJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    langgraph_jobs::ActiveModel {
        id: ActiveValue::Set(id),
        user_id: ActiveValue::Set(user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".into()),
        prompt: ActiveValue::Set(prompt.into()),
        capability: ActiveValue::Set(capability.into()),
        request_json: ActiveValue::Set(request_json),
        artifacts_json: ActiveValue::Set("[]".into()),
        result_json: ActiveValue::Set(None),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        offload_bucket_uid: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
    }
    .insert(db)
    .await
    .map_err(AppError::Database)
}

pub async fn set_output(
    db: &DatabaseConnection,
    id: i64,
    result: String,
    artifacts: String,
) -> Result<(), AppError> {
    langgraph_jobs::ActiveModel {
        id: ActiveValue::Set(id),
        result_json: ActiveValue::Set(Some(result)),
        artifacts_json: ActiveValue::Set(artifacts),
        ..Default::default()
    }
    .update(db)
    .await?;
    Ok(())
}
