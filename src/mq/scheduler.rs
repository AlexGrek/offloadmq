use axum::{Json, response::IntoResponse};
use log::debug;
use serde_json::json;

use crate::{
    db::{agent::CachedAgentStorage, persistent_task_storage::TaskStorage},
    error::AppError,
    models::{Agent, AssignedTask, UnassignedTask},
    mq::urgent::UrgentTaskStore,
    schema::{TaskId, TaskResultReport, TaskResultStatus, TaskStatus, TaskUpdate},
};

pub async fn find_urgent_tasks_with_capabilities(
    store: &UrgentTaskStore,
    caps: &Vec<String>,
) -> Option<UnassignedTask> {
    store.find_with_capabilities(caps).await
}

pub async fn find_assignable_non_urgent_tasks_with_capabilities_for_tier(
    store: &TaskStorage,
    caps: &Vec<String>,
    tier: u8,
    agents: &CachedAgentStorage,
) -> Result<Vec<UnassignedTask>, AppError> {
    let all = store.list_unassigned_with_caps(caps)?;
    let mut collected = vec![];
    debug!("Total jobs available: {} (our tier is {})", all.len(), tier);
    for task in all {
        let top_online_tier = all_online_agents_for(&task.id.cap, agents)
            .await
            .into_iter()
            .map(|agent| agent.tier)
            .max()
            .unwrap_or_default();
        if top_online_tier > tier {
            debug!(
                "Ingoring task with capability {}, as higher tier agents exist: {top_online_tier}",
                task.id.cap
            )
        } else {
            collected.push(task);
        }
    }
    Ok(collected)
}

pub async fn try_pick_up_urgent_task(
    store: &UrgentTaskStore,
    agent: &Agent,
    uid: &TaskId,
) -> Result<Option<AssignedTask>, AppError> {
    let success = store.assign_task(uid, &agent.uid).await;
    if !success {
        return Ok(None);
    }
    let task_opt = store.get_assigned_task(uid).await;
    if let Some(task) = task_opt {
        Ok(Some(task))
    } else {
        Err(AppError::Conflict(uid.to_string()))
    }
}

pub async fn try_pick_up_non_urgent_task(
    store: &TaskStorage,
    agent: &Agent,
    uid: TaskId,
) -> Result<AssignedTask, AppError> {
    let assigned = store.assign_task(&uid, &agent.uid)?;
    Ok(assigned)
}

pub async fn report_urgent_task<'a>(
    store: &'a UrgentTaskStore,
    report: TaskResultReport,
    task_id: TaskId,
) -> Result<bool, AppError> {
    let success = if let TaskResultStatus::Success(_duration) = report.status {
        true
    } else {
        false
    };
    store
        .complete_task(&task_id, success, report.output.clone().unwrap_or_default())
        .await
}

pub async fn update_urgent_task<'a>(
    store: &'a UrgentTaskStore,
    report: TaskUpdate,
    task_id: TaskId,
) -> Result<bool, AppError> {
    store
        .update_task(&task_id, report.log_update, report.stage)
        .await
}

pub async fn report_non_urgent_task<'a>(
    store: &TaskStorage,
    report: TaskResultReport,
) -> Result<(), AppError> {
    let success = if let TaskResultStatus::Success(_duration) = report.status {
        true
    } else {
        false
    };
    let mut got = store
        .get_assigned(&report.id)?
        .ok_or(AppError::NotFound(report.id.to_string()))?;
    got.change_status(if success {
        TaskStatus::Completed
    } else {
        TaskStatus::Failed
    });
    got.result = report.output;
    store.update_assigned(&got)?;
    Ok(())
}

pub async fn update_non_urgent_task<'a>(
    store: &TaskStorage,
    report: TaskUpdate,
) -> Result<(), AppError> {
    let mut got = store
        .get_assigned(&report.id)?
        .ok_or(AppError::NotFound(report.id.to_string()))?;
    got.append_log(report.log_update);
    if report.stage.is_some() {
        got.stage = report.stage
    }
    store.update_assigned(&got)?;
    Ok(())
}

pub async fn has_potential_agents_for(
    cap: &std::string::String,
    agents: &CachedAgentStorage,
) -> bool {
    for agent in agents.list_all_agents() {
        if agent.capabilities.contains(cap) && agent.is_online() {
            return true;
        }
    }
    return false;
}

pub async fn all_online_agents_for(
    cap: &std::string::String,
    agents: &CachedAgentStorage,
) -> Vec<Agent> {
    let mut collection = vec![];
    for agent in agents.list_all_agents() {
        if agent.capabilities.contains(cap) && agent.is_online() {
            collection.push(agent);
        }
    }
    collection.sort_by(|a, b| b.tier.cmp(&a.tier));
    collection
}

pub async fn submit_urgent_task(
    store: &UrgentTaskStore,
    agents: &CachedAgentStorage,
    task: UnassignedTask,
) -> Result<impl axum::response::IntoResponse, AppError> {
    if !has_potential_agents_for(&task.id.cap, agents).await {
        return Err(AppError::SchedulingImpossible(format!(
            "no online runners for capability {}",
            task.id.cap
        )));
    }
    let state = store.add_task(task.clone(), 60).await?;

    let mut rx = state.notify.subscribe();

    // Wait for status change that is terminal (Completed or Failed)
    loop {
        rx.changed().await.unwrap();
        let status = rx.borrow().clone();

        if status == TaskStatus::Completed || status == TaskStatus::Failed {
            if let Some(assigned_task) = store.get_assigned_task(&task.id).await {
                // Remove the task from the store after returning
                store.remove_task(&task.id).await;
                return Ok(Json(assigned_task).into_response());
            } else {
                store.remove_task(&task.id).await;

                return Ok(Json(json!({
                    "id": task.id,
                    "status": status,
                    "message": "Task completed but full info unavailable"
                }))
                .into_response());
            }
        }
    }
}
