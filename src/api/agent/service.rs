use std::sync::Arc;

use log::{debug, info};
use rand::seq::IndexedRandom;

use crate::{
    db::heuristic_storage::HeuristicStorage,
    error::AppError,
    models::{Agent, AssignedTask, CommunicationMethod, UnassignedTask},
    mq::scheduler::{
        find_assignable_non_urgent_tasks_with_capabilities_for_tier,
        find_urgent_tasks_with_capabilities, report_non_urgent_task, report_urgent_task,
        try_pick_up_non_urgent_task, try_pick_up_urgent_task, update_non_urgent_task,
        update_urgent_task,
    },
    schema::{
        AgentLoginRequest, AgentLoginResponse, AgentRegistrationRequest, AgentRegistrationResponse,
        AgentUpdateRequest, BucketStatResponse, DownloadedFile, FileStatEntry, TaskId,
        TaskResultReport, TaskUpdate,
    },
    state::AppState,
    utils::base_capability,
};

pub async fn poll_urgent(
    agent: Agent,
    state: &Arc<AppState>,
) -> Result<Option<UnassignedTask>, AppError> {
    let agent = state.storage.agents.update_agent_last_contact(agent, CommunicationMethod::Http)?;
    let caps = &agent.capabilities;
    Ok(find_urgent_tasks_with_capabilities(&state.urgent, caps, &agent.uid).await)
}

pub async fn poll_non_urgent(
    agent: Agent,
    state: &Arc<AppState>,
) -> Result<Option<UnassignedTask>, AppError> {
    let agent = state.storage.agents.update_agent_last_contact(agent, CommunicationMethod::Http)?;
    let caps = &agent.capabilities;
    debug!(
        "Searching for tasks for agent {:?} with tier {:?}",
        agent, agent.tier
    );
    let urgent = find_urgent_tasks_with_capabilities(&state.urgent, caps, &agent.uid).await;
    if let Some(task) = urgent {
        return Ok(Some(task));
    }
    let all = find_assignable_non_urgent_tasks_with_capabilities_for_tier(
        &state.storage.tasks,
        caps,
        agent.tier,
        &state.storage.agents,
        &agent.uid,
    )
    .await?;
    if all.len() > 0 {
        let mut rng = rand::rng();
        let random_item = all.choose(&mut rng).unwrap();
        Ok(Some(random_item.clone()))
    } else {
        Ok(None)
    }
}

fn validate_display_name(name: &Option<String>) -> Result<(), AppError> {
    if let Some(n) = name {
        if n.chars().count() > 50 {
            return Err(AppError::BadRequest(
                "display_name must be 50 characters or fewer".to_string(),
            ));
        }
    }
    Ok(())
}

pub fn do_update_agent_info(
    mut agent: Agent,
    req: AgentUpdateRequest,
    state: &Arc<AppState>,
) -> Result<AgentRegistrationResponse, AppError> {
    validate_display_name(&req.display_name)?;
    agent.capabilities = req.capabilities;
    agent.capacity = req.capacity;
    agent.system_info = req.system_info;
    agent.tier = req.tier;
    agent.app_version = req.app_version;
    agent.display_name = req.display_name;
    let uid = agent.uid.clone();
    let key = agent.personal_login_token.clone();
    state.storage.agents.update_agent_last_contact(agent, CommunicationMethod::Http)?;
    Ok(AgentRegistrationResponse {
        agent_id: uid,
        message: "Updated".to_string(),
        key,
    })
}

pub fn do_register_agent(
    req: AgentRegistrationRequest,
    state: &Arc<AppState>,
) -> Result<AgentRegistrationResponse, AppError> {
    validate_api_key(&state.config.agent_api_keys, &req.api_key)?;
    validate_display_name(&req.display_name)?;
    let mut agent_object: Agent = req.into();
    state.storage.agents.create_agent(&mut agent_object)?;
    Ok(AgentRegistrationResponse {
        agent_id: agent_object.uid,
        message: "Registered".to_string(),
        key: agent_object.personal_login_token,
    })
}

pub fn do_auth_agent(
    req: AgentLoginRequest,
    state: &Arc<AppState>,
) -> Result<AgentLoginResponse, AppError> {
    let mk_auth_err = || AppError::Authorization("Incorrect credentials".to_string());
    let agent = state
        .storage
        .agents
        .get_agent(&req.agent_id)
        .ok_or_else(|| mk_auth_err())?;
    if agent.personal_login_token != req.key {
        return Err(mk_auth_err());
    }
    let (token, expires_in) = state.auth.create_token(&agent.uid)?;
    Ok(AgentLoginResponse { token, expires_in })
}

pub fn get_bucket_stat(
    bucket_uid: &str,
    state: &Arc<AppState>,
) -> Result<BucketStatResponse, AppError> {
    let bucket = state
        .storage
        .buckets
        .get_bucket(bucket_uid)?
        .ok_or_else(|| AppError::NotFound(format!("Bucket {} not found", bucket_uid)))?;
    let files: Vec<FileStatEntry> = bucket
        .files
        .iter()
        .map(|f| FileStatEntry {
            file_uid: f.uid.clone(),
            original_name: f.original_name.clone(),
            size: f.size,
            sha256: f.sha256.clone(),
        })
        .collect();
    Ok(BucketStatResponse {
        bucket_uid: bucket.uid,
        file_count: files.len(),
        files,
    })
}

pub async fn get_bucket_file(
    bucket_uid: &str,
    file_uid: &str,
    state: &Arc<AppState>,
) -> Result<DownloadedFile, AppError> {
    let bucket = state
        .storage
        .buckets
        .get_bucket(bucket_uid)?
        .ok_or_else(|| AppError::NotFound(format!("Bucket {} not found", bucket_uid)))?;
    let file_meta = bucket
        .files
        .iter()
        .find(|f| f.uid == file_uid)
        .ok_or_else(|| {
            AppError::NotFound(format!("File {} not found in bucket {}", file_uid, bucket_uid))
        })?
        .clone();
    let data = state
        .storage
        .file_store
        .get(bucket_uid, file_uid)
        .await
        .map_err(AppError::Internal)?;
    Ok(DownloadedFile {
        data,
        original_name: file_meta.original_name,
    })
}

pub async fn take_task(
    agent: &Agent,
    task_id: TaskId,
    state: &Arc<AppState>,
) -> Result<AssignedTask, AppError> {
    info!("Agent {} picking up task {task_id}", agent.uid_short);
    let cap = base_capability(&task_id.cap);
    let machine_id = agent.system_info.machine_id.as_deref().unwrap_or("");
    let estimate = state.storage.heuristics.estimate_duration(cap, machine_id).unwrap_or(None);

    if let Some(mut picked) = try_pick_up_urgent_task(&state.urgent, agent, &task_id).await? {
        picked.typical_runtime_seconds = estimate;
        if let Some(d) = estimate {
            state.urgent.set_runtime_estimate(&task_id, d).await;
        }
        Ok(picked)
    } else {
        let mut assigned = try_pick_up_non_urgent_task(&state.storage.tasks, agent, task_id.clone()).await?;
        log_runner_history(agent, &task_id, &state.storage.heuristics);
        assigned.typical_runtime_seconds = estimate;
        if let Err(e) = state.storage.tasks.update_assigned(&assigned) {
            debug!("Failed to persist runtime estimate for task {task_id}: {e}");
        }
        Ok(assigned)
    }
}

fn log_runner_history(agent: &Agent, task_id: &TaskId, heuristics: &HeuristicStorage) {
    let cap = base_capability(&task_id.cap);
    match heuristics.compute_stats_for(&agent.uid, cap) {
        Err(e) => debug!("Failed to read heuristics for agent {} cap {}: {}", agent.uid_short, cap, e),
        Ok(None) => info!(
            "Agent {} | cap {} | first run — no history yet",
            agent.uid_short, cap
        ),
        Ok(Some(s)) => {
            let success_part = match (s.success_avg_ms, s.success_min_ms, s.success_max_ms) {
                (Some(avg), Some(min), Some(max)) =>
                    format!("ok: avg {:.0}ms  min {:.0}ms  max {:.0}ms", avg, min, max),
                _ => "ok: none".to_string(),
            };
            let fail_part = if s.fail_count > 0 {
                match (s.fail_avg_ms, s.fail_min_ms, s.fail_max_ms) {
                    (Some(avg), Some(min), Some(max)) =>
                        format!("  |  fail ({}): avg {:.0}ms  min {:.0}ms  max {:.0}ms", s.fail_count, avg, min, max),
                    _ => String::new(),
                }
            } else {
                String::new()
            };
            info!(
                "Agent {} | cap {} | {} runs  {:.1}% success  |  {}{}",
                agent.uid_short, cap, s.total_runs, s.success_pct, success_part, fail_part
            );
        }
    }
}

pub async fn resolve_task(
    agent: Agent,
    task_id: TaskId,
    report: TaskResultReport,
    state: &Arc<AppState>,
) -> Result<(), AppError> {
    let agent = state.storage.agents.update_agent_last_contact(agent, CommunicationMethod::Http)?;
    info!("Agent {} reporting task {task_id}", agent.uid_short);
    debug!("Report: {:?}", &report);

    let file_buckets: Vec<String> = state
        .urgent
        .get_assigned_task(&task_id)
        .await
        .map(|t| t.data.file_bucket)
        .or_else(|| {
            state
                .storage
                .tasks
                .get_assigned(&task_id)
                .ok()
                .flatten()
                .map(|t| t.data.file_bucket)
        })
        .unwrap_or_default();

    let mut cancel_err: Option<AppError> = None;
    match report_urgent_task(&state.urgent, report.clone(), task_id).await {
        Ok(true) => {}
        Ok(false) => {
            if let Err(e) = report_non_urgent_task(&state.storage.tasks, report, &agent, &state.storage.heuristics).await {
                if matches!(e, AppError::ClientClosedRequest(_)) {
                    cancel_err = Some(e);
                } else {
                    return Err(e);
                }
            }
        }
        Err(e) if matches!(e, AppError::ClientClosedRequest(_)) => {
            cancel_err = Some(e);
        }
        Err(e) => return Err(e),
    }

    for bucket_uid in &file_buckets {
        let bucket = match state.storage.buckets.get_bucket(bucket_uid) {
            Ok(Some(b)) => b,
            _ => continue,
        };
        if !bucket.rm_after_task {
            continue;
        }
        state
            .storage
            .file_store
            .delete_bucket(bucket_uid)
            .await
            .map_err(AppError::Internal)?;
        state
            .storage
            .buckets
            .delete_bucket(bucket_uid, &bucket.api_key)
            .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
        info!(
            "Deleted rm_after_task bucket {} after task completion",
            bucket_uid
        );
    }

    if let Some(e) = cancel_err {
        return Err(e);
    }
    Ok(())
}

pub async fn update_task_progress(
    agent: Agent,
    task_id: TaskId,
    update: TaskUpdate,
    state: &Arc<AppState>,
) -> Result<(), AppError> {
    let agent = state.storage.agents.update_agent_last_contact(agent, CommunicationMethod::Http)?;
    info!(
        "Agent {} updating task {task_id} with log: {:?}",
        agent.uid_short,
        update.log_update.as_ref().map(|s| s.len()).unwrap_or(0)
    );
    debug!("Update: {:?}", &update);

    let found = update_urgent_task(&state.urgent, update.clone(), task_id).await?;
    if !found {
        update_non_urgent_task(&state.storage.tasks, update).await?;
    }
    Ok(())
}

pub(crate) fn validate_api_key(keys: &[String], key: &str) -> Result<(), AppError> {
    if !keys.iter().any(|item| item == key) {
        return Err(AppError::Authorization("Incorrect API key".to_string()));
    }
    Ok(())
}
