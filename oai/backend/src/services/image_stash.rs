//! Image-generation stash: requests the user saved to run later instead of
//! submitting them now. An entry is a stored `POST /api/images/jobs` body; starting
//! it removes the entry and submits that body as an ordinary image job.
//!
//! The stored prompt is the raw template — `{color}`, custom placeholders and `{?}`
//! are expanded when the entry is started (like the MCP tools, server-side via
//! [`PromptExpander`]), so a stashed request draws fresh values at run time.

use serde::Serialize;
use serde_json::Value;

use crate::{
    db::image_stash::{self, StashEntry},
    error::AppError,
    services::{
        image_jobs::{self, StartJobParams},
        prompt_expansion::PromptExpander,
    },
    state::AppState,
};

/// Per-user cap — the stash is a to-do list, not an archive.
pub const MAX_STASH_ENTRIES: u64 = 200;
/// Upper bound on one stored request body.
const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Serialize)]
pub struct StashEntryView {
    pub id: String,
    pub created_at: String,
    /// The stored `StartJobParams` JSON, as the client sent it.
    pub request: Value,
}

fn view(entry: StashEntry) -> StashEntryView {
    let request = serde_json::from_str(&entry.request_json).unwrap_or(Value::Null);
    StashEntryView {
        id: entry.id.to_string(),
        created_at: entry.created_at.to_rfc3339(),
        request,
    }
}

fn parse_request(value: Value) -> Result<StartJobParams, AppError> {
    serde_json::from_value(value).map_err(|e| AppError::BadRequest(format!("invalid request: {e}")))
}

pub async fn list(state: &AppState, user_id: i64) -> Result<Vec<StashEntryView>, AppError> {
    Ok(image_stash::list_for_user(&state.db, user_id)
        .await?
        .into_iter()
        .map(view)
        .collect())
}

/// Validate `request` exactly as `start_job` would (capability, prompt, input image
/// ownership, admin-only priority) and save it.
pub async fn stash(
    state: &AppState,
    user_id: i64,
    request: Value,
) -> Result<StashEntryView, AppError> {
    let request_json =
        serde_json::to_string(&request).map_err(|e| AppError::Internal(e.to_string()))?;
    if request_json.len() > MAX_REQUEST_BYTES {
        return Err(AppError::BadRequest(format!(
            "stashed request exceeds {MAX_REQUEST_BYTES} bytes"
        )));
    }
    let req = parse_request(request)?;
    image_jobs::validate_request(state, user_id, &req).await?;
    if image_stash::count_for_user(&state.db, user_id).await? >= MAX_STASH_ENTRIES {
        return Err(AppError::BadRequest(format!(
            "stash is full ({MAX_STASH_ENTRIES} entries) — start or delete some first"
        )));
    }
    let entry = image_stash::create(&state.db, state.next_id(), user_id, request_json).await?;
    Ok(view(entry))
}

pub async fn delete(state: &AppState, user_id: i64, id: i64) -> Result<(), AppError> {
    image_stash::delete(&state.db, user_id, id).await
}

/// Remove the entry and submit it as an image job; returns the new job id. If the
/// submit fails the entry is put back, so a transient error never loses it.
pub async fn start(state: &AppState, user_id: i64, id: i64) -> Result<i64, AppError> {
    let entry = image_stash::take(&state.db, user_id, id).await?;
    match submit(state, user_id, &entry).await {
        Ok(job_id) => Ok(job_id),
        Err(e) => {
            if let Err(restore_err) = image_stash::restore(&state.db, entry).await {
                tracing::warn!(stash_id = id, error = %restore_err, "failed to restore stash entry after a failed start");
            }
            Err(e)
        }
    }
}

async fn submit(state: &AppState, user_id: i64, entry: &StashEntry) -> Result<i64, AppError> {
    let value: Value = serde_json::from_str(&entry.request_json)
        .map_err(|e| AppError::Internal(format!("stored stash request: {e}")))?;
    let mut req = parse_request(value)?;
    let template = req
        .prompt_template
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| req.prompt.clone());
    let mut expander = PromptExpander::for_user(&state.db, user_id).await?;
    req.prompt = expander.expand(&template)?;
    req.prompt_template = Some(template);
    image_jobs::start_job(state, user_id, req).await
}
