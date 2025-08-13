use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    response::IntoResponse,
};
use log::{debug, info};
use rand::seq::IndexedRandom;
use serde_json::json;

use crate::{
    error::AppError,
    middleware::AuthenticatedAgent,
    models::UnassignedTask,
    mq::scheduler::{
        find_assignable_non_urgent_tasks_with_capabilities_for_tier,
        find_urgent_tasks_with_capabilities, report_non_urgent_task, report_urgent_task,
        try_pick_up_non_urgent_task, try_pick_up_urgent_task,
    },
    schema::{TaskId, TaskResultReport},
    state::AppState,
};

pub async fn fetch_task_urgent_handler(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    agent = app_state.storage.agents.update_agent_last_contact(agent)?;
    let caps = &agent.capabilities;
    let urgent = find_urgent_tasks_with_capabilities(&app_state.urgent, caps).await;
    Ok(Json(urgent))
}

pub async fn fetch_task_non_urgent_handler(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    agent = app_state.storage.agents.update_agent_last_contact(agent)?;
    let caps = &agent.capabilities;
    debug!(
        "Searching for tasks for agent {:?} with tier {:?}",
        agent, agent.tier
    );
    let all = find_assignable_non_urgent_tasks_with_capabilities_for_tier(
        &app_state.storage.tasks,
        caps,
        agent.tier,
        &app_state.storage.agents,
    )
    .await?;
    if all.len() > 0 {
        // pick random
        let mut rng = rand::rng();
        let random_item = all.choose(&mut rng).unwrap(); // we already checked length
        Ok(Json(random_item).into_response())
    } else {
        Ok(Json(Option::<UnassignedTask>::None).into_response())
    }
}

pub async fn try_take_task_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    let task_id = TaskId { cap, id };
    info!("Agent {} picking up task {task_id}", agent.uid_short);
    if let Some(picked) = try_pick_up_urgent_task(&app_state.urgent, &agent, &task_id).await? {
        Ok(Json(picked))
    } else {
        Ok(Json(
            try_pick_up_non_urgent_task(&app_state.storage.tasks, &agent, task_id).await?,
        ))
    }
}

pub async fn post_task_resolution(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
    Json(report): Json<TaskResultReport>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    agent = app_state.storage.agents.update_agent_last_contact(agent)?;
    let task_id = TaskId {
        cap,
        id: id.clone(),
    };
    if report.id != task_id {
        return Err(AppError::BadRequest(id));
    }
    info!("Agent {} reporting task {task_id}", agent.uid_short);
    debug!("Report: {:?}", &report);

    let found = report_urgent_task(&app_state.urgent, report.clone(), task_id).await?;
    if !found {
        report_non_urgent_task(&app_state.storage.tasks, report).await?;
    }
    Ok(Json(json!({"message": "task report confirmed"})))
}
