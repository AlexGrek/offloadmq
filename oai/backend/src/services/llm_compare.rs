//! LLM compare: submit the same prompt to multiple models in parallel and
//! reconcile each OffloadMQ task until all slots reach a terminal state.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{
    db::llm_compare,
    error::AppError,
    offload::{base_capability, task_status, ChatMessage, OffloadClient, TaskId},
    services::{llm_text_capabilities, offload_factory, offload_job::CancelOutcome},
    state::AppState,
};

const MIN_SLOTS: usize = 2;
const MAX_SLOTS: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompareSlot {
    pub model: String,
    pub status: String,
    pub offload_cap: Option<String>,
    pub offload_task_id: Option<String>,
    pub content: Option<String>,
    pub log: Option<String>,
    pub error: Option<String>,
}

pub struct StartJobParams {
    pub models: Vec<String>,
    pub system_prompt: String,
    pub user_prompt: String,
}

fn slot_is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "canceled")
}

fn parse_slots(json: &str) -> Result<Vec<CompareSlot>, AppError> {
    serde_json::from_str(json).map_err(|e| AppError::Internal(format!("invalid slots_json: {e}")))
}

fn serialize_slots(slots: &[CompareSlot]) -> Result<String, AppError> {
    serde_json::to_string(slots).map_err(|e| AppError::Internal(format!("serialize slots: {e}")))
}

fn build_messages(system_prompt: &str, user_prompt: &str) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    let system = system_prompt.trim();
    if !system.is_empty() {
        messages.push(ChatMessage {
            role: "system".into(),
            content: system.to_string(),
        });
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: user_prompt.trim().to_string(),
    });
    messages
}

fn normalize_capability(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.starts_with("llm.") {
        base_capability(trimmed).to_string()
    } else {
        format!("llm.{}", base_capability(trimmed))
    }
}

fn recompute_job_status(slots: &[CompareSlot]) -> (String, Option<String>) {
    if slots.is_empty() {
        return ("failed".into(), Some("no model slots".into()));
    }
    if slots.iter().any(|s| !slot_is_terminal(&s.status)) {
        return ("running".into(), None);
    }
    let completed = slots.iter().filter(|s| s.status == "completed").count();
    if completed > 0 {
        ("completed".into(), None)
    } else {
        let err = slots
            .iter()
            .find_map(|s| s.error.as_deref())
            .unwrap_or("all compare slots failed");
        ("failed".into(), Some(err.to_string()))
    }
}

async fn poll_one_slot(client: &OffloadClient, slot: &mut CompareSlot) -> Result<(), AppError> {
    if slot_is_terminal(&slot.status) {
        return Ok(());
    }
    let (Some(cap), Some(id)) = (&slot.offload_cap, &slot.offload_task_id) else {
        if slot.status == "submitting" {
            slot.status = "failed".into();
            slot.error = Some("compare slot submit did not complete".into());
        }
        return Ok(());
    };
    let task_id = TaskId {
        cap: cap.clone(),
        id: id.clone(),
    };
    let poll = match client.poll_task(&task_id).await {
        Ok(p) => p,
        Err(e) => {
            if let Some(reason) = task_status::offload_task_missing_message(&e) {
                slot.status = "failed".into();
                slot.error = Some(reason);
                return Ok(());
            }
            return Err(e);
        }
    };
    if let Some(log) = poll.log.filter(|l| !l.is_empty()) {
        slot.log = Some(log);
    }
    match poll.status.as_str() {
        "completed" => {
            let text = task_status::extract_llm_text(&poll.output);
            if text.is_empty() {
                slot.status = "failed".into();
                slot.error = Some("model returned empty response".into());
            } else {
                slot.status = "completed".into();
                slot.content = Some(text);
                slot.log = None;
            }
        }
        "failed" => {
            slot.status = "failed".into();
            slot.error = Some(task_status::extract_error_text(
                &poll.output,
                "compare task failed",
            ));
        }
        "canceled" => {
            slot.status = "canceled".into();
        }
        other => {
            slot.status = other.to_string();
        }
    }
    Ok(())
}

async fn reconcile_slots(
    state: &AppState,
    job_id: i64,
    slots: &mut [CompareSlot],
) -> Result<(), AppError> {
    let client = offload_factory::chat_client(state).await?;
    for slot in slots.iter_mut() {
        poll_one_slot(&client, slot).await?;
    }
    let (status, error) = recompute_job_status(slots);
    let slots_json = serialize_slots(slots)?;
    llm_compare::update_job(&state.db, job_id, &status, &slots_json, error.as_deref()).await
}

pub async fn list_capabilities(
    state: &AppState,
) -> Result<Vec<crate::offload::LlmCapabilityInfo>, AppError> {
    llm_text_capabilities::list_text_llm_capabilities(state).await
}

pub async fn start_job(
    state: &AppState,
    user_id: i64,
    req: StartJobParams,
) -> Result<i64, AppError> {
    let user_prompt = req.user_prompt.trim();
    if user_prompt.is_empty() {
        return Err(AppError::BadRequest("user_prompt is required".into()));
    }
    if req.models.len() < MIN_SLOTS || req.models.len() > MAX_SLOTS {
        return Err(AppError::BadRequest(format!(
            "between {MIN_SLOTS} and {MAX_SLOTS} models are required"
        )));
    }
    let mut seen = HashSet::new();
    for model in &req.models {
        let cap = normalize_capability(model);
        if cap == "llm." || !seen.insert(cap.clone()) {
            return Err(AppError::BadRequest("each model must be a unique llm capability".into()));
        }
    }

    let mut slots: Vec<CompareSlot> = req
        .models
        .iter()
        .map(|m| CompareSlot {
            model: normalize_capability(m),
            status: "submitting".into(),
            offload_cap: None,
            offload_task_id: None,
            content: None,
            log: None,
            error: None,
        })
        .collect();

    let job_id = state.next_id();
    let slots_json = serialize_slots(&slots)?;
    llm_compare::create_job(
        &state.db,
        llm_compare::NewJobInput {
            id: job_id,
            user_id,
            system_prompt: req.system_prompt.trim(),
            user_prompt,
            slots_json: &slots_json,
        },
    )
    .await?;

    let client = offload_factory::chat_client(state).await?;
    let messages = build_messages(req.system_prompt.trim(), user_prompt);

    for slot in slots.iter_mut() {
        match client.submit_chat(&slot.model, messages.clone(), None, None, None, None).await {
            Ok(task_id) => {
                slot.status = "submitted".into();
                slot.offload_cap = Some(task_id.cap);
                slot.offload_task_id = Some(task_id.id);
            }
            Err(e) => {
                slot.status = "failed".into();
                slot.error = Some(e.to_string());
            }
        }
    }

    let (status, error) = recompute_job_status(&slots);
    let slots_json = serialize_slots(&slots)?;
    llm_compare::update_job(&state.db, job_id, &status, &slots_json, error.as_deref()).await?;

    Ok(job_id)
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<llm_compare::LlmCompareJob, AppError> {
    let job = llm_compare::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if task_status::is_terminal(&job.status) {
        return Ok(job);
    }
    let mut slots = parse_slots(&job.slots_json)?;
    reconcile_slots(state, job_id, &mut slots).await?;
    llm_compare::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelOutcome, AppError> {
    let job = llm_compare::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if task_status::is_terminal(&job.status) {
        return Err(AppError::BadRequest(format!(
            "job is already in terminal state: {}",
            job.status
        )));
    }

    let mut slots = parse_slots(&job.slots_json)?;
    let client = offload_factory::chat_client(state).await?;
    let mut canceled_any = false;

    for slot in slots.iter_mut() {
        if slot_is_terminal(&slot.status) {
            continue;
        }
        if let (Some(cap), Some(id)) = (&slot.offload_cap, &slot.offload_task_id) {
            let task_id = TaskId {
                cap: cap.clone(),
                id: id.clone(),
            };
            match client.cancel_task(&task_id).await {
                Ok(resp) => {
                    slot.status = resp.status;
                    canceled_any = true;
                }
                Err(e) => {
                    if task_status::offload_task_missing_message(&e).is_some() {
                        slot.status = "failed".into();
                        slot.error = Some(task_status::OFFLOAD_TASK_MISSING.to_string());
                    } else {
                        return Err(e);
                    }
                }
            }
        } else {
            slot.status = "canceled".into();
            canceled_any = true;
        }
    }

    let (status, error) = recompute_job_status(&slots);
    let slots_json = serialize_slots(&slots)?;
    llm_compare::update_job(&state.db, job_id, &status, &slots_json, error.as_deref()).await?;

    Ok(CancelOutcome {
        job_id,
        status: if canceled_any { "canceled".into() } else { status },
        message: "Compare run canceled".into(),
    })
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    llm_compare::delete_job(&state.db, job_id, user_id).await
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<llm_compare::LlmCompareJob>, AppError> {
    llm_compare::list_jobs(&state.db, user_id, limit).await
}

pub async fn user_job_detail(
    state: &AppState,
    job_id: i64,
    user_id: i64,
) -> Result<llm_compare::LlmCompareJob, AppError> {
    llm_compare::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn retry_job(state: &AppState, user_id: i64, job_id: i64) -> Result<i64, AppError> {
    let job = user_job_detail(state, job_id, user_id).await?;
    if !matches!(job.status.as_str(), "failed" | "canceled") {
        return Err(AppError::BadRequest(format!(
            "only failed or canceled jobs can be retried (status={})",
            job.status
        )));
    }
    let slots = parse_slots(&job.slots_json)?;
    let models: Vec<String> = slots.iter().map(|s| s.model.clone()).collect();
    start_job(
        state,
        user_id,
        StartJobParams {
            models,
            system_prompt: job.system_prompt,
            user_prompt: job.user_prompt,
        },
    )
    .await
}

pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch: u64,
) -> Result<(), AppError> {
    let jobs = llm_compare::list_inflight_jobs(&state.db, batch).await?;
    for job in jobs {
        if let Ok(mut slots) = parse_slots(&job.slots_json) {
            let _ = reconcile_slots(state, job.id, &mut slots).await;
        }
    }
    Ok(())
}

pub fn parse_job_slots(job: &llm_compare::LlmCompareJob) -> Result<Vec<CompareSlot>, AppError> {
    parse_slots(&job.slots_json)
}
