//! Best-effort "remember this prompt" for the prompt library.
//!
//! Job-submission handlers record the prompts a user just used so they show up under
//! *recent* without the frontend issuing a second request. That bookkeeping must never
//! fail the submission itself — but a silent `let _ =` also hides real DB trouble, so
//! this helper swallows the error *and* logs it.

use crate::{db::prompts, error::AppError, state::AppState};

/// Records `content` as a recent entry in `bucket` for `user_id`.
///
/// Never fails. A `BadRequest` (empty/oversized prompt, unknown bucket) is the library
/// legitimately refusing the text and happens on ordinary input, so it is only a debug
/// line; anything else is a warning.
pub async fn note_use(state: &AppState, user_id: i64, bucket: &str, content: &str) {
    match prompts::record_use(&state.db, || state.next_id(), user_id, bucket, content).await {
        Ok(_) => {}
        Err(AppError::BadRequest(reason)) => {
            tracing::debug!(bucket, "prompt not recorded: {reason}");
        }
        Err(e) => tracing::warn!(bucket, "record prompt use failed: {e:?}"),
    }
}
