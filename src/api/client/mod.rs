use std::{collections::HashSet, sync::Arc};

use axum::{
    Json,
    extract::{Path, State},
    response::IntoResponse,
};
use chrono::Utc;
use log::info;
use serde_json::json;

use crate::{
    db::apikeys::ApiKeysStorage,
    error::AppError,
    models::{Agent, UnassignedTask},
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
                Some(ass.into_status_report())
            }
        })
        .flatten()
        .or(app_state
            .storage
            .tasks
            .get_unassigned(&task_id)?
            .map(|unass| {
                if unass.data.api_key != req.api_key {
                    None
                } else {
                    Some(unass.into_status_report())
                }
            })
            .flatten());
    if let Some(response) = task {
        return Ok(Json(response).into_response());
    } else {
        if let Some(urgent) = app_state.urgent.get_assigned_task(&task_id).await {
            return Ok(Json(urgent).into_response());
        }
        return Err(AppError::NotFound(task_id.to_string()));
    }
}

pub async fn capabilities_online(
    State(app_state): State<Arc<AppState>>,
    Json(req): Json<ApiKeyRequest>,
) -> Result<impl IntoResponse, AppError> {
    let key = app_state
        .storage
        .client_keys
        .find_active(&req.api_key)?
        .ok_or_else(|| AppError::Authorization("API key not found".to_string()))?;
    let mut capabilities = HashSet::new();
    app_state
        .storage
        .agents
        .list_all_agents()
        .into_iter()
        .filter(Agent::is_online)
        .map(|agent| agent.capabilities)
        .for_each(|cap_list| capabilities.extend(cap_list));
    capabilities.retain(|el| ApiKeysStorage::has_capability(&key.capabilities, el));
    Ok(Json(capabilities))
}
