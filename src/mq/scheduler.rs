use log::debug;
use uuid::Uuid;

use crate::{
    db::{
        agent::CachedAgentStorage,
        persistent_task_storage::TaskStorage,
    },
    error::AppError,
    models::{Agent, AssignedTask, UnassignedTask},
    mq::urgent::UrgentTaskStore,
    schema::{TaskResultReport, TaskResultStatus, TaskStatus},
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
        let top_online_tier = all_online_agents_for(&task.capability, agents).await.into_iter().map(|agent|agent.tier).max().unwrap_or_default();
        if top_online_tier > tier {
            debug!("Ingoring task with capability {}, as higher tier agents exist: {top_online_tier}", task.capability)
        } else {
            collected.push(task);
        }
    }
    Ok(collected)
}

pub async fn try_pick_up_urgent_task(
    store: &UrgentTaskStore,
    agent: &Agent,
    uid: &uuid::Uuid,
) -> Result<AssignedTask, AppError> {
    let success = store.assign_task(uid, &agent.uid).await;
    if !success {
        return Err(AppError::NotFound(uid.to_string()));
    }
    let task_opt = store.get_assigned_task(uid).await;
    if let Some(task) = task_opt {
        Ok(task)
    } else {
        Err(AppError::Conflict(uid.to_string()))
    }
}

pub async fn try_pick_up_non_urgent_task(
    store: &TaskStorage,
    agent: &Agent,
    uid: uuid::Uuid,
    capability: &str,
) -> Result<AssignedTask, AppError> {
    let assigned = store.assign_task(capability, uid, &agent.uid)?;
    Ok(assigned)
}

pub async fn report_urgent_task<'a>(
    store: &'a UrgentTaskStore,
    report: TaskResultReport,
    task_id: Uuid,
) -> Result<bool, AppError> {
    let success = report.status == TaskResultStatus::Completed;
    store
        .complete_task(&task_id, success, report.output.clone().unwrap_or_default())
        .await
}

pub async fn report_non_urgent_task<'a>(
    store: &TaskStorage,
    report: TaskResultReport,
    task_id: Uuid,
    
) -> Result<(), AppError> {
    let capability = &report.capability;
    let success = report.status == TaskResultStatus::Completed;
    let mut got = store.get_assigned(capability, task_id)?.ok_or(AppError::NotFound(task_id.to_string()))?;
    got.status = if success {TaskStatus::Completed} else {TaskStatus::Failed};
    got.result = report.output;
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
    return collection;
}
