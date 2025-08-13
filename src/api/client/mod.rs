use std::sync::Arc;

use axum::{Json, extract::State, response::IntoResponse};
use chrono::Utc;
use log::{info};
use serde_json::json;

use crate::{
    error::AppError,
    models::UnassignedTask,
    mq::scheduler::submit_urgent_task,
    schema::{TaskId, TaskSubmissionRequest},
    state::AppState,
};

pub async fn submit_task_blocking(
    State(app_state): State<Arc<AppState>>,
    Json(req): Json<TaskSubmissionRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    if !req.urgent {
        return Err(AppError::BadRequest(
            "Only urgent tasks can be submitted to this endpoint".to_string(),
        ));
    }
    let task = UnassignedTask {
        id: TaskId::new_with_cap(req.capability.clone()),
        data: req,
        created_at: Utc::now(),
    };
    info!("New urgent task: {:?}", task);
    let data = submit_urgent_task(&app_state.urgent, &app_state.storage.agents, task)
        .await?
        .into_response();
    Ok(data)
}

pub async fn submit_task(
    State(app_state): State<Arc<AppState>>,
    Json(req): Json<TaskSubmissionRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let urgent = req.urgent;
    let task = UnassignedTask {
        id: TaskId::new_with_cap(req.capability.clone()),
        data: req,
        created_at: Utc::now(),
    };
    info!("New unassigned task: {:?}", task);
    if urgent {
        let data = submit_urgent_task(&app_state.urgent, &app_state.storage.agents, task)
            .await?
            .into_response();
        Ok(data)
    } else {
        // non-urgent task, use regular queue
        app_state.storage.tasks.add_unassigned(&task)?;
        return Ok(Json(json!({
            "id": task.id,
            "capability": task.id.cap,
            "status": "pending",
            "message": "Added to tasks queue"
        }))
        .into_response());
    }
}
