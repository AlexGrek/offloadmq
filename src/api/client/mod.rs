use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    response::IntoResponse,
};
use chrono::Utc;
use log::info;
use serde_json::json;

use crate::{
    error::AppError,
    models::UnassignedTask,
    mq::scheduler::submit_urgent_task,
    schema::{ApiKeyRequest, TaskId, TaskSubmissionRequest},
    state::AppState,
};

pub async fn submit_task_blocking(
    State(app_state): State<Arc<AppState>>,
    Json(req): Json<TaskSubmissionRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    app_state
        .storage
        .client_keys
        .verify_key(&req.api_key, &req.capability)?;
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
    app_state
        .storage
        .client_keys
        .verify_key(&req.api_key, &req.capability)?;
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

pub async fn poll_task_status(
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
    Json(req): Json<ApiKeyRequest>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    let task_id = TaskId::from_url(id, cap)?;
    let task = app_state
        .storage
        .tasks
        .get_assigned(&task_id)?
        .map(|ass| {
            if ass.data.api_key != req.api_key {
                None
            } else {
                Some(ass)
            }
        })
        .flatten()
        .map(|ass| Json(ass).into_response())
        .or(app_state
            .storage
            .tasks
            .get_unassigned(&task_id)?
            .map(|unass| {
                if unass.data.api_key != req.api_key {
                    None
                } else {
                    Some(unass)
                }
            })
            .flatten()
            .map(|un| Json(un).into_response()));
    if let Some(response) = task {
        return Ok(response);
    } else {
        if let Some(urgent) = app_state.urgent.get_assigned_task(&task_id).await {
            return Ok(Json(urgent).into_response());
        }
        return Err(AppError::NotFound(task_id.to_string()));
    }
}
