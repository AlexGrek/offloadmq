//! TTS job orchestration: persist text-to-speech jobs, submit to OffloadMQ
//! `tts.*` tasks, and persist the synthesized audio blob (via OpenDAL) on
//! completion. The poll/cancel/reconcile state machine is the shared
//! [`offload_job`] driver; this module supplies only the TTS-specific pieces:
//! capability listing, job submission, and the completed-result handler.

use async_trait::async_trait;
use base64::Engine;
use serde::Serialize;

use crate::{
    db::{
        entities::tts_jobs::Entity as TtsJobEntity,
        generation_parameters, offload_jobs, tts,
    },
    error::AppError,
    offload::task_status::NormalizedPoll,
    services::{
        offload_factory,
        offload_job::{self, CancelOutcome, JobReconciler},
        storage,
    },
    state::AppState,
};

#[derive(Debug, Serialize)]
pub struct TtsCapability {
    pub base: String,
    pub voices: Vec<String>,
    pub raw: String,
    pub online: bool,
    pub last_available_at: String,
}

pub struct StartJobParams {
    pub capability: String,
    pub voice: String,
    pub text: String,
}

pub struct JobDetail {
    pub job: tts::TtsJob,
}

/// Drives the generic poll/cancel/reconcile lifecycle for TTS jobs.
struct TtsReconciler;

#[async_trait]
impl JobReconciler for TtsReconciler {
    type Entity = TtsJobEntity;

    fn label(&self) -> &'static str {
        "tts"
    }

    fn failure_fallback(&self) -> &'static str {
        "tts task failed"
    }

    async fn poller(
        &self,
        state: &AppState,
    ) -> Result<Box<dyn crate::offload::task_status::OffloadPoller>, AppError> {
        Ok(Box::new(offload_factory::chat_client(state).await?))
    }

    async fn on_completed(
        &self,
        state: &AppState,
        job: &tts::TtsJob,
        poll: &NormalizedPoll,
    ) -> Result<(), AppError> {
        let Some(output) = poll.output.as_ref() else {
            return fail(state, job.id, "tts task returned no output").await;
        };
        let b64 = output
            .get("audio_data_base64")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty());
        let Some(b64) = b64 else {
            return fail(state, job.id, "tts task output missing audio_data_base64").await;
        };
        let content_type = output
            .get("content_type")
            .and_then(|v| v.as_str())
            .unwrap_or("audio/wav")
            .to_string();
        let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(b) => b,
            Err(e) => {
                return fail(state, job.id, &format!("invalid audio_data_base64: {e}")).await;
            }
        };
        let path = audio_storage_path(job.user_id, job.id, &job.text, &content_type);
        let op = storage::operator(state)?;
        storage::write(op, &path, bytes.clone()).await?;
        tts::set_audio(&state.db, job.id, &path, &content_type, bytes.len() as i64).await?;
        let filename = path.rsplit('/').next().unwrap_or(&path).to_string();
        if let Err(e) = record_tts_generation_parameters(state, job, &filename, &content_type).await
        {
            tracing::warn!("failed to record generation parameters for tts job {}: {e}", job.id);
        }
        Ok(())
    }
}

async fn fail(state: &AppState, job_id: i64, message: &str) -> Result<(), AppError> {
    offload_jobs::update_status::<TtsJobEntity>(&state.db, job_id, "failed", None, Some(message))
        .await
}

pub async fn list_tts_capabilities(state: &AppState) -> Result<Vec<TtsCapability>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let now = chrono::Utc::now().to_rfc3339();
    let caps = client.list_capabilities_with_prefix("tts.").await?;
    Ok(caps
        .into_iter()
        .map(|c| TtsCapability {
            base: c.base,
            voices: c.tags,
            raw: c.raw,
            online: true,
            last_available_at: now.clone(),
        })
        .collect())
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    req: StartJobParams,
) -> Result<i64, AppError> {
    storage::operator(state)?;

    let text = req.text.trim();
    if text.is_empty() {
        return Err(AppError::BadRequest("text is required".into()));
    }
    if req.capability.is_empty() {
        return Err(AppError::BadRequest("capability is required".into()));
    }
    if !req.capability.starts_with("tts.") {
        return Err(AppError::BadRequest("capability must start with `tts.`".into()));
    }
    let voice = req.voice.trim();
    if voice.is_empty() {
        return Err(AppError::BadRequest("voice is required".into()));
    }
    let model = req.capability.trim_start_matches("tts.").to_string();
    if model.is_empty() {
        return Err(AppError::BadRequest("invalid tts capability".into()));
    }

    let job_id = state.next_id();
    tts::create_job(
        &state.db,
        tts::NewJobInput {
            id: job_id,
            user_id,
            text,
            capability: &req.capability,
            voice,
            model: &model,
        },
    )
    .await?;

    let client = offload_factory::chat_client(state).await?;
    let task_id = client.submit_tts_task(&req.capability, &model, voice, text).await?;

    offload_jobs::set_offload_task::<TtsJobEntity>(
        &state.db,
        job_id,
        &task_id.cap,
        &task_id.id,
        None,
    )
    .await?;

    Ok(job_id)
}

pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = offload_jobs::get_job::<TtsJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if !matches!(job.status.as_str(), "failed" | "canceled") {
        return Err(AppError::BadRequest(format!(
            "only failed or canceled jobs can be retried (status={})",
            job.status
        )));
    }
    start_job(
        state,
        user_id,
        StartJobParams {
            capability: job.capability.clone(),
            voice: job.voice.clone(),
            text: job.text.clone(),
        },
    )
    .await
}

pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelOutcome, AppError> {
    offload_job::cancel_job(&TtsReconciler, state, user_id, job_id).await
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    let job = offload_jobs::get_job::<TtsJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if let Some(path) = job.audio_storage_path.as_deref() {
        let op = storage::operator(state)?;
        storage::delete(op, path).await?;
    }
    offload_jobs::delete_job::<TtsJobEntity>(&state.db, job_id, user_id).await
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<tts::TtsJob, AppError> {
    offload_job::poll_job(&TtsReconciler, state, user_id, job_id).await
}

pub async fn user_job_detail(
    state: &AppState,
    job_id: i64,
    user_id: i64,
) -> Result<JobDetail, AppError> {
    let job = offload_jobs::get_job::<TtsJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(JobDetail { job })
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<tts::TtsJob>, AppError> {
    offload_jobs::list_jobs::<TtsJobEntity>(&state.db, user_id, limit).await
}

/// Returns `(bytes, content_type)` for the synthesized audio. Errors with
/// `NotFound` until the job completes.
pub async fn audio_bytes(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<(Vec<u8>, String), AppError> {
    let job = offload_jobs::get_job::<TtsJobEntity>(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let Some(path) = job.audio_storage_path else {
        return Err(AppError::NotFound);
    };
    let content_type = job.audio_content_type.unwrap_or_else(|| "audio/wav".to_string());
    let op = storage::operator(state)?;
    let bytes = storage::read(op, &path).await?;
    Ok((bytes, content_type))
}

/// Background worker pass: advances in-flight TTS jobs.
pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    offload_job::reconcile_pass(&TtsReconciler, state, batch_size).await
}

async fn record_tts_generation_parameters(
    state: &AppState,
    job: &tts::TtsJob,
    filename: &str,
    content_type: &str,
) -> Result<(), AppError> {
    let parameters = serde_json::json!({
        "source": "audio",
        "job_id": job.id.to_string(),
        "text": job.text,
        "capability": job.capability,
        "model": job.model,
        "voice": job.voice,
        "content_type": content_type,
        "created_at": job.created_at.to_rfc3339(),
    });
    generation_parameters::upsert(
        &state.db,
        generation_parameters::UpsertInput {
            id: state.next_id(),
            user_id: job.user_id,
            filename,
            source: "audio",
            parameters,
        },
    )
    .await
}

fn audio_storage_path(user_id: i64, job_id: i64, text: &str, content_type: &str) -> String {
    let ext = match content_type {
        ct if ct.contains("mpeg") => "mp3",
        ct if ct.contains("ogg") => "ogg",
        ct if ct.contains("flac") => "flac",
        ct if ct.contains("aac") => "aac",
        _ => "wav",
    };
    let slug = sanitize_filename_slug(text, 50);
    format!("users/{user_id}/tts/{slug}-{job_id}.{ext}")
}

/// Build a filesystem-safe slug from arbitrary input text: keep ASCII
/// alphanumerics and `-`, collapse everything else into single underscores,
/// trim edges, truncate to `max_chars`. Falls back to `"speech"` if nothing
/// printable remains.
pub fn sanitize_filename_slug(input: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(max_chars);
    let mut prev_underscore = false;
    for ch in input.chars() {
        if out.chars().count() >= max_chars {
            break;
        }
        if ch.is_ascii_alphanumeric() || ch == '-' {
            out.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "speech".to_string()
    } else {
        trimmed.to_string()
    }
}
