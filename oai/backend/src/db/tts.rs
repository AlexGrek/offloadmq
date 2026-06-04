//! TTS job persistence. The lifecycle columns are handled generically via
//! [`crate::db::offload_jobs`]; only TTS-specific writes (`create_job`,
//! `set_audio`) and the framework trait impls live here.

use sea_orm::{ActiveModelTrait, ActiveValue, DatabaseConnection};

use crate::{
    db::{
        entities::tts_jobs::{self, Entity as TtsJobEntity},
        offload_jobs::{OffloadJobEntity, OffloadJobModel},
    },
    error::AppError,
};

pub type TtsJob = tts_jobs::Model;

impl OffloadJobModel for tts_jobs::Model {
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

impl OffloadJobEntity for TtsJobEntity {
    fn col_id() -> Self::Column {
        tts_jobs::Column::Id
    }
    fn col_user_id() -> Self::Column {
        tts_jobs::Column::UserId
    }
    fn col_status() -> Self::Column {
        tts_jobs::Column::Status
    }
    fn col_stage() -> Self::Column {
        tts_jobs::Column::Stage
    }
    fn col_error() -> Self::Column {
        tts_jobs::Column::Error
    }
    fn col_created_at() -> Self::Column {
        tts_jobs::Column::CreatedAt
    }
    fn col_updated_at() -> Self::Column {
        tts_jobs::Column::UpdatedAt
    }
    fn col_offload_cap() -> Self::Column {
        tts_jobs::Column::OffloadCap
    }
    fn col_offload_task_id() -> Self::Column {
        tts_jobs::Column::OffloadTaskId
    }
}

pub struct NewJobInput<'a> {
    pub id: i64,
    pub user_id: i64,
    pub text: &'a str,
    pub capability: &'a str,
    pub voice: &'a str,
    pub model: &'a str,
}

pub async fn create_job(
    db: &DatabaseConnection,
    input: NewJobInput<'_>,
) -> Result<TtsJob, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = tts_jobs::ActiveModel {
        id: ActiveValue::Set(input.id),
        user_id: ActiveValue::Set(input.user_id),
        created_at: ActiveValue::Set(now),
        updated_at: ActiveValue::Set(now),
        status: ActiveValue::Set("created".to_string()),
        text: ActiveValue::Set(input.text.to_string()),
        capability: ActiveValue::Set(input.capability.to_string()),
        voice: ActiveValue::Set(input.voice.to_string()),
        model: ActiveValue::Set(input.model.to_string()),
        offload_cap: ActiveValue::Set(None),
        offload_task_id: ActiveValue::Set(None),
        audio_storage_path: ActiveValue::Set(None),
        audio_content_type: ActiveValue::Set(None),
        audio_size_bytes: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        error: ActiveValue::Set(None),
    };
    model.insert(db).await.map_err(AppError::Database)
}

pub async fn set_audio(
    db: &DatabaseConnection,
    job_id: i64,
    storage_path: &str,
    content_type: &str,
    size_bytes: i64,
) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let model = tts_jobs::ActiveModel {
        id: ActiveValue::Set(job_id),
        status: ActiveValue::Set("completed".to_string()),
        audio_storage_path: ActiveValue::Set(Some(storage_path.to_string())),
        audio_content_type: ActiveValue::Set(Some(content_type.to_string())),
        audio_size_bytes: ActiveValue::Set(Some(size_bytes)),
        error: ActiveValue::Set(None),
        stage: ActiveValue::Set(None),
        updated_at: ActiveValue::Set(now),
        ..Default::default()
    };
    model.update(db).await.map_err(AppError::Database)?;
    Ok(())
}
