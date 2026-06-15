//! LLM debate: two models take turns in a conversation; an optional referee
//! model may judge the transcript after a configured number of turns.

use serde::{Deserialize, Serialize};

use crate::{
    db::llm_debate,
    error::AppError,
    offload::{base_capability, task_status, ChatMessage, OffloadClient, TaskId},
    services::{llm_text_capabilities, offload_factory, offload_job::CancelOutcome},
    state::AppState,
    ws::events::ServerEvent,
};

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

/// Agent flushes streaming log to OffloadMQ about every 2s; poll slightly faster.
const WS_POLL_INTERVAL: Duration = Duration::from_secs(1);

pub const DEFAULT_REFEREE_SYSTEM: &str = "You are an impartial debate referee. You will be given a transcript of a debate between two participants labeled \"Model A\" and \"Model B\". Analyze the quality of their arguments, reasoning, and overall performance. Declare a winner with a brief justification.";

pub const DEFAULT_REFEREE_COMMAND: &str = "The debate has concluded. Review the full transcript above and declare a winner. Be concise: state who won (Model A or Model B, or a draw) and why in 2–3 sentences.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebateMessageView {
    pub side: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebateJobView {
    pub job_id: String,
    pub status: String,
    pub model_a: String,
    pub model_b: String,
    pub system_a: String,
    pub system_b: String,
    pub initial_prompt: String,
    pub referee_enabled: bool,
    pub model_ref: Option<String>,
    pub system_ref: Option<String>,
    pub command_ref: Option<String>,
    pub referee_turns: i32,
    pub messages: Vec<DebateMessageView>,
    pub phase: String,
    pub current_turn: Option<String>,
    pub active_log: Option<String>,
    pub stage: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub fn job_view(job: llm_debate::LlmDebateJob) -> Result<DebateJobView, AppError> {
    let messages = parse_job_messages(&job)?
        .into_iter()
        .map(|m| DebateMessageView {
            side: m.side,
            content: m.content,
        })
        .collect();
    Ok(DebateJobView {
        job_id: job.id.to_string(),
        status: job.status,
        model_a: job.model_a,
        model_b: job.model_b,
        system_a: job.system_a,
        system_b: job.system_b,
        initial_prompt: job.initial_prompt,
        referee_enabled: job.referee_enabled,
        model_ref: job.model_ref,
        system_ref: job.system_ref,
        command_ref: job.command_ref,
        referee_turns: job.referee_turns,
        messages,
        phase: job.phase,
        current_turn: job.current_turn,
        active_log: job.active_log,
        stage: job.stage,
        error: job.error,
        created_at: job.created_at.to_rfc3339(),
        updated_at: job.updated_at.to_rfc3339(),
    })
}

pub async fn list_capabilities_ws(
    req_id: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
) {
    match list_capabilities(state).await {
        Ok(capabilities) => {
            let _ = tx.send(ServerEvent::Capabilities { req_id, capabilities });
        }
        Err(e) => send_ws_error(tx, Some(&req_id), &e.to_string()),
    }
}

pub async fn watch_job_ws(
    req_id: String,
    job_id_str: String,
    tx: &UnboundedSender<ServerEvent>,
    state: &Arc<AppState>,
    user_id: i64,
) {
    let job_id = match job_id_str.parse::<i64>() {
        Ok(id) => id,
        Err(_) => {
            send_ws_error(tx, Some(&req_id), "invalid job_id");
            return;
        }
    };

    loop {
        let mut job = match llm_debate::get_job(&state.db, job_id, user_id).await {
            Ok(Some(j)) => j,
            Ok(None) => {
                send_ws_error(tx, Some(&req_id), "job not found");
                return;
            }
            Err(e) => {
                send_ws_error(tx, Some(&req_id), &e.to_string());
                return;
            }
        };

        if !task_status::is_terminal(&job.status) {
            if let Err(e) = reconcile_job(state, &mut job).await {
                send_ws_error(tx, Some(&req_id), &e.to_string());
                return;
            }
        }

        let terminal = task_status::is_terminal(&job.status);
        match job_view(job) {
            Ok(view) => {
                let _ = tx.send(ServerEvent::DebateUpdate {
                    req_id: req_id.clone(),
                    job: view,
                    terminal,
                });
            }
            Err(e) => {
                send_ws_error(tx, Some(&req_id), &e.to_string());
                return;
            }
        }

        if terminal {
            return;
        }

        tokio::time::sleep(WS_POLL_INTERVAL).await;
    }
}

fn send_ws_error(tx: &UnboundedSender<ServerEvent>, req_id: Option<&str>, message: &str) {
    let _ = tx.send(ServerEvent::Error {
        req_id: req_id.map(str::to_string),
        message: message.to_string(),
    });
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebateMessage {
    pub side: String,
    pub content: String,
}

pub struct StartJobParams {
    pub model_a: String,
    pub model_b: String,
    pub system_a: String,
    pub system_b: String,
    pub initial_prompt: String,
    pub referee_enabled: bool,
    pub model_ref: Option<String>,
    pub system_ref: Option<String>,
    pub command_ref: Option<String>,
    pub referee_turns: i32,
}

fn normalize_capability(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.starts_with("llm.") {
        base_capability(trimmed).to_string()
    } else {
        format!("llm.{}", base_capability(trimmed))
    }
}

fn parse_messages(json: &str) -> Result<Vec<DebateMessage>, AppError> {
    serde_json::from_str(json).map_err(|e| AppError::Internal(format!("invalid messages_json: {e}")))
}

fn serialize_messages(messages: &[DebateMessage]) -> Result<String, AppError> {
    serde_json::to_string(messages).map_err(|e| AppError::Internal(format!("serialize messages: {e}")))
}

fn build_debate_messages(
    side: &str,
    system: &str,
    messages: &[DebateMessage],
    user_content: &str,
) -> Vec<ChatMessage> {
    let mut out = vec![ChatMessage {
        role: "system".into(),
        content: system.to_string(),
    }];
    for msg in messages {
        if msg.side == "REF" {
            continue;
        }
        let role = if msg.side == side { "assistant" } else { "user" };
        out.push(ChatMessage {
            role: role.into(),
            content: msg.content.clone(),
        });
    }
    out.push(ChatMessage {
        role: "user".into(),
        content: user_content.to_string(),
    });
    out
}

fn build_referee_messages(
    system: &str,
    messages: &[DebateMessage],
    command: &str,
) -> Vec<ChatMessage> {
    let transcript = messages
        .iter()
        .filter(|m| m.side != "REF")
        .map(|m| format!("Model {}: {}", m.side, m.content))
        .collect::<Vec<_>>()
        .join("\n\n");
    vec![
        ChatMessage {
            role: "system".into(),
            content: system.to_string(),
        },
        ChatMessage {
            role: "user".into(),
            content: format!("Here is the debate transcript:\n\n{transcript}\n\n{command}"),
        },
    ]
}

fn model_for_side<'a>(job: &'a llm_debate::LlmDebateJob, side: &str) -> Option<&'a str> {
    match side {
        "A" => Some(job.model_a.as_str()),
        "B" => Some(job.model_b.as_str()),
        "REF" => job.model_ref.as_deref(),
        _ => None,
    }
}

fn system_for_side<'a>(job: &'a llm_debate::LlmDebateJob, side: &str) -> &'a str {
    match side {
        "A" => job.system_a.as_str(),
        "B" => job.system_b.as_str(),
        "REF" => job
            .system_ref
            .as_deref()
            .unwrap_or(DEFAULT_REFEREE_SYSTEM),
        _ => "",
    }
}

async fn submit_turn(
    client: &OffloadClient,
    job: &mut llm_debate::LlmDebateJob,
    side: &str,
    user_content: &str,
    messages: &[DebateMessage],
) -> Result<(), AppError> {
    let capability = model_for_side(job, side)
        .ok_or_else(|| AppError::Internal(format!("unknown debate side: {side}")))?;
    let capability = normalize_capability(capability);
    let chat_messages = if side == "REF" {
        let command = job
            .command_ref
            .as_deref()
            .unwrap_or(DEFAULT_REFEREE_COMMAND);
        build_referee_messages(system_for_side(job, side), messages, command)
    } else {
        build_debate_messages(side, system_for_side(job, side), messages, user_content)
    };

    let task_id = client
        .submit_chat(&capability, chat_messages, None, None, None, None)
        .await?;

    job.current_turn = Some(side.to_string());
    job.offload_cap = Some(task_id.cap);
    job.offload_task_id = Some(task_id.id);
    job.active_log = None;
    job.stage = None;
    job.status = "running".into();
    if side == "REF" {
        job.phase = "referee".into();
    }
    Ok(())
}

async fn reconcile_job(state: &AppState, job: &mut llm_debate::LlmDebateJob) -> Result<(), AppError> {
    if task_status::is_terminal(&job.status) {
        return Ok(());
    }
    let client = offload_factory::chat_client(state).await?;
    if job.offload_cap.is_none() && job.offload_task_id.is_none() && job.messages_json == "[]" {
        let initial = job.initial_prompt.trim().to_string();
        submit_turn(&client, job, "A", &initial, &[]).await?;
        return llm_debate::update_job_state(&state.db, job).await;
    }

    let (Some(cap), Some(id)) = (&job.offload_cap, &job.offload_task_id) else {
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
                job.status = "failed".into();
                job.error = Some(reason);
                job.offload_cap = None;
                job.offload_task_id = None;
                return llm_debate::update_job_state(&state.db, job).await;
            }
            return Err(e);
        }
    };
    if let Some(log) = poll.log.filter(|l| !l.is_empty()) {
        job.active_log = Some(log);
    }
    if let Some(stage) = poll.stage {
        job.stage = Some(stage);
    }

    match poll.status.as_str() {
        "completed" => {
            let text = task_status::extract_llm_text(&poll.output);
            if text.is_empty() {
                job.status = "failed".into();
                job.error = Some("model returned empty response".into());
                job.offload_cap = None;
                job.offload_task_id = None;
            } else {
                let side = job.current_turn.clone().unwrap_or_else(|| "A".to_string());
                let mut messages = parse_messages(&job.messages_json)?;
                messages.push(DebateMessage {
                    side: side.clone(),
                    content: text,
                });
                job.messages_json = serialize_messages(&messages)?;
                job.offload_cap = None;
                job.offload_task_id = None;
                job.active_log = None;
                job.stage = None;

                if side == "REF" {
                    job.phase = "done".into();
                    job.current_turn = None;
                    job.status = "completed".into();
                } else {
                    let debate_count = messages.iter().filter(|m| m.side != "REF").count();
                    let should_referee = job.referee_enabled
                        && job.model_ref.is_some()
                        && debate_count >= job.referee_turns as usize;
                    if should_referee {
                        submit_turn(&client, job, "REF", "", &messages).await?;
                    } else {
                        let next_side = if side == "A" { "B" } else { "A" };
                        let last_content = messages.last().map(|m| m.content.as_str()).unwrap_or("");
                        submit_turn(&client, job, next_side, last_content, &messages).await?;
                    }
                }
            }
        }
        "failed" => {
            job.status = "failed".into();
            job.error = Some(task_status::extract_error_text(
                &poll.output,
                "debate task failed",
            ));
            job.offload_cap = None;
            job.offload_task_id = None;
        }
        "canceled" => {
            job.status = "canceled".into();
            job.offload_cap = None;
            job.offload_task_id = None;
        }
        other => {
            job.status = other.to_string();
        }
    }
    llm_debate::update_job_state(&state.db, job).await
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
    let initial = req.initial_prompt.trim();
    if initial.is_empty() {
        return Err(AppError::BadRequest("initial_prompt is required".into()));
    }
    let model_a = normalize_capability(&req.model_a);
    let model_b = normalize_capability(&req.model_b);
    if model_a == "llm." || model_b == "llm." {
        return Err(AppError::BadRequest("model_a and model_b are required".into()));
    }
    if model_a == model_b {
        return Err(AppError::BadRequest("model_a and model_b must differ".into()));
    }
    if req.referee_enabled {
        let model_ref = req
            .model_ref
            .as_deref()
            .ok_or_else(|| AppError::BadRequest("model_ref is required when referee is enabled".into()))?;
        if normalize_capability(model_ref) == "llm." {
            return Err(AppError::BadRequest("invalid referee model".into()));
        }
    }
    let referee_turns = req.referee_turns.clamp(2, 100);
    let model_ref_normalized = req
        .model_ref
        .as_ref()
        .map(|m| normalize_capability(m))
        .filter(|_| req.referee_enabled);
    let system_ref = if req.referee_enabled {
        req.system_ref
            .as_deref()
            .or(Some(DEFAULT_REFEREE_SYSTEM))
    } else {
        None
    };
    let command_ref = if req.referee_enabled {
        req.command_ref
            .as_deref()
            .or(Some(DEFAULT_REFEREE_COMMAND))
    } else {
        None
    };

    let job_id = state.next_id();
    let mut job = llm_debate::create_job(
        &state.db,
        llm_debate::NewJobInput {
            id: job_id,
            user_id,
            model_a: &model_a,
            model_b: &model_b,
            system_a: req.system_a.trim(),
            system_b: req.system_b.trim(),
            initial_prompt: initial,
            referee_enabled: req.referee_enabled,
            model_ref: model_ref_normalized.as_deref(),
            system_ref,
            command_ref,
            referee_turns,
        },
    )
    .await?;

    let client = offload_factory::chat_client(state).await?;
    submit_turn(&client, &mut job, "A", initial, &[]).await?;
    llm_debate::update_job_state(&state.db, &job).await?;

    Ok(job_id)
}

pub async fn poll_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<llm_debate::LlmDebateJob, AppError> {
    let mut job = llm_debate::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    reconcile_job(state, &mut job).await?;
    llm_debate::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn cancel_job(
    state: &AppState,
    user_id: i64,
    job_id: i64,
) -> Result<CancelOutcome, AppError> {
    let mut job = llm_debate::get_job(&state.db, job_id, user_id)
        .await?
        .ok_or(AppError::NotFound)?;
    if task_status::is_terminal(&job.status) {
        return Err(AppError::BadRequest(format!(
            "job is already in terminal state: {}",
            job.status
        )));
    }

    if let (Some(cap), Some(id)) = (&job.offload_cap, &job.offload_task_id) {
        let client = offload_factory::chat_client(state).await?;
        let task_id = TaskId {
            cap: cap.clone(),
            id: id.clone(),
        };
        match client.cancel_task(&task_id).await {
            Ok(resp) => {
                job.status = resp.status;
            }
            Err(e) => {
                if let Some(reason) = task_status::offload_task_missing_message(&e) {
                    job.status = "failed".into();
                    job.error = Some(reason);
                } else {
                    return Err(e);
                }
            }
        }
    } else {
        job.status = "canceled".into();
    }
    job.offload_cap = None;
    job.offload_task_id = None;
    job.active_log = None;
    llm_debate::update_job_state(&state.db, &job).await?;

    Ok(CancelOutcome {
        job_id,
        status: job.status.clone(),
        message: "Debate canceled".into(),
    })
}

pub async fn delete_job(state: &AppState, user_id: i64, job_id: i64) -> Result<(), AppError> {
    llm_debate::delete_job(&state.db, job_id, user_id).await
}

pub async fn list_user_jobs(
    state: &AppState,
    user_id: i64,
    limit: u64,
) -> Result<Vec<llm_debate::LlmDebateJob>, AppError> {
    llm_debate::list_jobs(&state.db, user_id, limit).await
}

pub async fn user_job_detail(
    state: &AppState,
    job_id: i64,
    user_id: i64,
) -> Result<llm_debate::LlmDebateJob, AppError> {
    llm_debate::get_job(&state.db, job_id, user_id)
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
    start_job(
        state,
        user_id,
        StartJobParams {
            model_a: job.model_a,
            model_b: job.model_b,
            system_a: job.system_a,
            system_b: job.system_b,
            initial_prompt: job.initial_prompt,
            referee_enabled: job.referee_enabled,
            model_ref: job.model_ref,
            system_ref: job.system_ref,
            command_ref: job.command_ref,
            referee_turns: job.referee_turns,
        },
    )
    .await
}

pub async fn run_background_reconcile_pass(
    state: &AppState,
    batch: u64,
) -> Result<(), AppError> {
    let jobs = llm_debate::list_inflight_jobs(&state.db, batch).await?;
    for mut job in jobs {
        let _ = reconcile_job(state, &mut job).await;
    }
    Ok(())
}

pub fn parse_job_messages(job: &llm_debate::LlmDebateJob) -> Result<Vec<DebateMessage>, AppError> {
    parse_messages(&job.messages_json)
}
