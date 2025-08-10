use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    response::IntoResponse,
};
use chrono::Utc;
use log::info;
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    error::AppError,
    middleware::AuthenticatedAgent,
    models::UnassignedTask,
    mq::{
        scheduler::{
            find_urgent_tasks_with_capabilities, report_urgent_task, try_pick_up_urgent_task,
        },
        urgent::UrgentTaskStore,
    },
    schema::{TaskResultReport, TaskStatus, TaskSubmissionRequest},
    state::AppState,
};

pub mod scheduler;
pub mod urgent;

async fn submit_urgent_task(
    store: &UrgentTaskStore,
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

pub async fn submit_urgent_task_handler(
    State(app_state): State<Arc<AppState>>,
    Json(req): Json<TaskSubmissionRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let task = UnassignedTask {
        id: Uuid::new_v4(),
        capability: req.capability,
        urgent: true,
        restartable: false,
        payload: req.payload,
        created_at: Utc::now(),
    };
    info!("New urgent task: {:?}", task);
    let data = submit_urgent_task(&app_state.urgent, task)
        .await?
        .into_response();
    Ok(data)
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

// #[derive(Deserialize)]
// pub struct TaskUidQuery {
//     id: String,
// }

pub async fn try_take_task_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    let task_id = uuid::Uuid::parse_str(&id).map_err(|_e| AppError::BadRequest(id))?;
    info!("Agent {} picking up task {task_id}", agent.uid_short);
    Ok(Json(
        try_pick_up_urgent_task(&app_state.urgent, &agent, &task_id).await?,
    ))
}

pub async fn post_task_resolution(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(report): Json<TaskResultReport>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    let task_id = uuid::Uuid::parse_str(&id).map_err(|_e| AppError::BadRequest(id))?;
    info!("Agent {} reporting task {task_id}", agent.uid_short);
    report_urgent_task(&app_state.urgent, report, task_id).await
}
