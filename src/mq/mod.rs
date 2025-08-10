use std::sync::Arc;

use axum::{extract::{Query, State}, response::IntoResponse, Json};
use serde_json::json;

use crate::{
    error::AppError, middleware::AuthenticatedAgent, models::UnassignedTask, mq::{scheduler::{find_urgent_tasks_with_capabilities, try_pick_up_urgent_task}, urgent::UrgentTaskStore}, schema::TaskStatus, state::AppState
};

pub mod urgent;
pub mod scheduler;

async fn submit_urgent_task_handler(
    store: Arc<UrgentTaskStore>,
    task: UnassignedTask,
) -> Result<impl axum::response::IntoResponse, AppError> {
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

pub async fn fetch_task_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    let caps = &agent.capabilities;
    let urgent = find_urgent_tasks_with_capabilities(&app_state.urgent, caps).await;
    Ok(Json(urgent))
}

pub async fn try_take_task_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Query(id): Query<String>
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    let task_id = uuid::Uuid::parse_str(&id).map_err(|_e| AppError::BadRequest(id))?;
    Ok(Json(try_pick_up_urgent_task(&app_state.urgent, &agent, &task_id).await?))
}

