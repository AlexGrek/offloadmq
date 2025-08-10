use axum::{Json, response::IntoResponse};
use serde_json::json;
use uuid::Uuid;

use crate::{
    db::agent::{self, CachedAgentStorage},
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

pub async fn report_urgent_task<'a>(
    store: &'a UrgentTaskStore,
    report: TaskResultReport,
    task_id: Uuid,
) -> Result<impl IntoResponse + use<>, AppError> {
    let success = report.status == TaskResultStatus::Completed;
    store
        .complete_task(&task_id, success, report.output.clone().unwrap_or_default())
        .await?;
    Ok(Json(json!({"status": "confirmed"})))
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
