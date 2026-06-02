//! TTS job orchestration: persist text-to-speech jobs, submit to OffloadMQ
//! tts.* tasks, poll for results and reconcile in-flight jobs in the
//! background. Mirrors the image-analysis service but produces an audio blob
//! stored via OpenDAL.

use base64::Engine;
use serde::Serialize;

use crate::{
    db::{generation_parameters, tts},
    error::AppError,
    offload::{PollResponse, TaskId},
    services::{offload_factory, storage},
    state::AppState,
};

#[derive(Debug, Serialize)]
pub struct TtsCapability {
    pub base: String,
    pub voices: Vec<String>,
    pub raw: String,
}

pub struct StartJobParams {
    pub capability: String,
    pub voice: String,
    pub text: String,
}

pub struct JobDetail {
    pub job: tts::TtsJob,
}

pub struct CancelJobOutcome {
    pub job_id: i64,
    pub status: String,
    pub message: String,
}

pub async fn list_tts_capabilities(state: &AppState) -> Result<Vec<TtsCapability>, AppError> {
    let client = offload_factory::chat_client(state).await?;
    let caps = client.list_capabilities_with_prefix("tts.").await?;
    Ok(caps
        .into_iter()
        .map(|c| TtsCapability {
            base: c.base,
            voices: c.tags,
            raw: c.raw,
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
        return Err(AppError::BadRequest(
            "capability must start with `tts.`".into(),
        ));
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
    let task_id = client
        .submit_tts_task(&req.capability, &model, voice, text)
        .await?;

    tts::set_offload_task(&state.db, job_id, &task_id.cap, &task_id.id).await?;

    Ok(job_id)
}

pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = tts::get_job(&state.db, job_id, user_id)
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
) -> Result<CancelJobOutcome, AppError> {
    let job = tts::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if is_terminal(&job.status) {
        return Err(AppError::BadRequest(format!(
            "job is already in terminal state: {}",
            job.status
        )));
    }

    let (Some(cap), Some(task_id)) = (job.offload_cap.clone(), job.offload_task_id.clone()) else {
        let message = "Canceled before OffloadMQ task was created";
        tts::update_status(&state.db, job.id, "canceled", None, Some(message)).await?;
        return Ok(CancelJobOutcome {
            job_id: job.id,
            status: "canceled".into(),
            message: message.into(),
        });
    };

    let client = offload_factory::chat_client(state).await?;
    match client.cancel_task(&TaskId { cap, id: task_id }).await {
        Ok(resp) => {
            tts::update_status(&state.db, job.id, &resp.status, None, None).await?;
            Ok(CancelJobOutcome {
                job_id: job.id,
                status: resp.status,
                message: resp.message,
            })
        }
        Err(e) => {
            if let Some(reason) = offload_task_missing_message(&e) {
                tts::update_status(&state.db, job.id, "failed", None, Some(&reason)).await?;
                Ok(CancelJobOutcome {
                    job_id: job.id,
                    status: "failed".into(),
                    message: reason,
                })
            } else {
                Err(e)
            }
        }
    }
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    let job = tts::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if let Some(path) = job.audio_storage_path.as_deref() {
        let op = storage::operator(state)?;
        storage::delete(op, path).await?;
    }
    tts::delete_job(&state.db, job_id, user_id).await
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<tts::TtsJob, AppError> {
    let job = tts::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if is_terminal(&job.status) {
        return Ok(job);
    }
    let Some(cap) = job.offload_cap.clone() else {
        return Ok(job);
    };
    let Some(task_id) = job.offload_task_id.clone() else {
        return Ok(job);
    };
    if let Err(e) = run_poll_once(state, &job, &cap, &task_id).await {
        if let Some(reason) = offload_task_missing_message(&e) {
            tts::update_status(&state.db, job.id, "failed", None, Some(&reason)).await?;
        } else {
            return Err(e);
        }
    }
    tts::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn user_job_detail(
    state: &AppState,
    job_id: i64,
    user_id: i64,
) -> Result<JobDetail, AppError> {
    let job = tts::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(JobDetail { job })
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<tts::TtsJob>, AppError> {
    tts::list_jobs(&state.db, user_id, limit).await
}

/// Returns `(bytes, content_type)` for the synthesized audio. Errors with
/// `NotFound` until the job completes.
pub async fn audio_bytes(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<(Vec<u8>, String), AppError> {
    let job = tts::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    let Some(path) = job.audio_storage_path else {
        return Err(AppError::NotFound);
    };
    let content_type = job
        .audio_content_type
        .unwrap_or_else(|| "audio/wav".to_string());
    let op = storage::operator(state)?;
    let bytes = storage::read(op, &path).await?;
    Ok((bytes, content_type))
}

/// Background worker pass: advances in-flight TTS jobs.
pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch_size: u64,
) -> Result<(), AppError> {
    let jobs = tts::list_jobs_for_background_worker(&state.db, batch_size).await?;
    for job in jobs {
        let (Some(cap), Some(task_id)) = (job.offload_cap.clone(), job.offload_task_id.clone())
        else {
            continue;
        };
        match run_poll_once(state, &job, &cap, &task_id).await {
            Ok(()) => {}
            Err(e) => {
                if let Some(reason) = offload_task_missing_message(&e) {
                    let _ = tts::update_status(
                        &state.db,
                        job.id,
                        "failed",
                        None,
                        Some(&reason),
                    )
                    .await;
                } else {
                    tracing::warn!("tts poll failed for job {}: {e}", job.id);
                }
            }
        }
    }
    Ok(())
}

async fn run_poll_once(
    state: &AppState,
    job: &tts::TtsJob,
    cap: &str,
    task_id: &str,
) -> Result<(), AppError> {
    let client = offload_factory::chat_client(state).await?;
    let poll = client
        .poll_task(&TaskId {
            cap: cap.to_string(),
            id: task_id.to_string(),
        })
        .await?;
    apply_poll(state, job, &poll).await
}

async fn apply_poll(
    state: &AppState,
    job: &tts::TtsJob,
    poll: &PollResponse,
) -> Result<(), AppError> {
    match poll.status.as_str() {
        "completed" => {
            let Some(output) = poll.output.as_ref() else {
                tts::update_status(
                    &state.db,
                    job.id,
                    "failed",
                    None,
                    Some("tts task returned no output"),
                )
                .await?;
                return Ok(());
            };
            let b64 = output
                .get("audio_data_base64")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());
            let Some(b64) = b64 else {
                tts::update_status(
                    &state.db,
                    job.id,
                    "failed",
                    None,
                    Some("tts task output missing audio_data_base64"),
                )
                .await?;
                return Ok(());
            };
            let content_type = output
                .get("content_type")
                .and_then(|v| v.as_str())
                .unwrap_or("audio/wav")
                .to_string();
            let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
                Ok(b) => b,
                Err(e) => {
                    tts::update_status(
                        &state.db,
                        job.id,
                        "failed",
                        None,
                        Some(&format!("invalid audio_data_base64: {e}")),
                    )
                    .await?;
                    return Ok(());
                }
            };
            let path = audio_storage_path(job.user_id, job.id, &job.text, &content_type);
            let op = storage::operator(state)?;
            storage::write(op, &path, bytes.clone()).await?;
            tts::set_audio(&state.db, job.id, &path, &content_type, bytes.len() as i64)
                .await?;
            let filename = path
                .rsplit('/')
                .next()
                .unwrap_or(&path)
                .to_string();
            if let Err(e) = record_tts_generation_parameters(state, job, &filename, &content_type)
                .await
            {
                tracing::warn!(
                    "failed to record generation parameters for tts job {}: {e}",
                    job.id
                );
            }
        }
        "failed" => {
            let err = extract_error_text(&poll.output);
            tts::update_status(&state.db, job.id, "failed", None, Some(&err)).await?;
        }
        "canceled" => {
            tts::update_status(&state.db, job.id, "canceled", None, None).await?;
        }
        other => {
            tts::update_status(&state.db, job.id, other, poll.stage.as_deref(), None).await?;
        }
    }
    Ok(())
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

fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "canceled")
}

fn extract_error_text(output: &Option<serde_json::Value>) -> String {
    output
        .as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).or_else(|| v.as_str()))
        .unwrap_or("tts task failed")
        .to_string()
}

const OFFLOAD_TASK_MISSING: &str =
    "OffloadMQ task not found (likely deleted or archived on the server)";

fn offload_task_missing_message(err: &AppError) -> Option<String> {
    let AppError::ExternalService(msg) = err else {
        return None;
    };
    if let Some(rest) = msg.strip_prefix("POLL_HTTP_") {
        if offload_http_is_task_missing(rest) {
            return Some(OFFLOAD_TASK_MISSING.to_string());
        }
    }
    if let Some(rest) = msg.strip_prefix("CANCEL_HTTP_") {
        if offload_http_is_task_missing(rest) {
            return Some(OFFLOAD_TASK_MISSING.to_string());
        }
    }
    let lower = msg.to_ascii_lowercase();
    if lower.contains("not found") || lower.contains("not_found") {
        return Some(OFFLOAD_TASK_MISSING.to_string());
    }
    None
}

fn offload_http_is_task_missing(rest: &str) -> bool {
    matches!(
        rest.split_once(':').map(|(code, _)| code),
        Some("404") | Some("410")
    )
}
