use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    response::IntoResponse,
};
use chrono::Utc;
use log::{debug, info};
use rand::seq::IndexedRandom;
use serde_json::json;

use crate::{
    error::AppError,
    middleware::AuthenticatedAgent,
    models::{Agent, UnassignedTask},
    mq::scheduler::{
        find_assignable_non_urgent_tasks_with_capabilities_for_tier,
        find_urgent_tasks_with_capabilities, report_non_urgent_task, report_urgent_task,
        try_pick_up_non_urgent_task, try_pick_up_urgent_task, update_non_urgent_task,
        update_urgent_task,
    },
    schema::{self, TaskId, TaskResultReport, TaskUpdate},
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
    let urgent = find_urgent_tasks_with_capabilities(&app_state.urgent, caps).await;
    if let Some(urgent_found) = urgent {
        return Ok(Json(urgent_found).into_response());
    }
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

pub async fn update_agent_info(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(state): State<Arc<AppState>>,
    Json(info): Json<schema::AgentUpdateRequest>,
) -> Result<impl IntoResponse, AppError> {
    agent.capabilities = info.capabilities;
    agent.capacity = info.capacity;
    agent.last_contact = Some(Utc::now());
    agent.system_info = info.system_info;
    agent.tier = info.tier;

    let uid = agent.uid.clone();
    let key = agent.personal_login_token.clone();

    state.storage.agents.update_agent(agent)?;
    Ok(Json(schema::AgentRegistrationResponse {
        agent_id: uid,
        message: "Updated".to_string(),
        key: key,
    }))
}

pub async fn register_agent(
    State(state): State<Arc<AppState>>,
    Json(agent): Json<schema::AgentRegistrationRequest>,
) -> Result<impl IntoResponse, AppError> {
    validate_api_key(&state.config.agent_api_keys, &agent.api_key)?;
    let mut agent_object: Agent = agent.into();
    state.storage.agents.create_agent(&mut agent_object)?;
    Ok(Json(schema::AgentRegistrationResponse {
        agent_id: agent_object.uid,
        message: "Registered".to_string(),
        key: agent_object.personal_login_token,
    }))
}

pub async fn auth_agent(
    State(state): State<Arc<AppState>>,
    Json(request): Json<schema::AgentLoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    let mk_auth_err = || AppError::Authorization("Incorrect credentials".to_string());
    let agent = state
        .storage
        .agents
        .get_agent(&request.agent_id)
        .ok_or_else(|| mk_auth_err())?;
    if agent.personal_login_token != request.key {
        return Err(mk_auth_err());
    }
    let (token, expires_in) = state.auth.create_token(&agent.uid)?;
    Ok(Json(schema::AgentLoginResponse { token, expires_in }))
}

fn validate_api_key(keys: &Vec<String>, key: &str) -> Result<(), AppError> {
    if keys.iter().find(|item| *item == key).is_none() {
        return Err(AppError::Authorization("Incorrect API key".to_string()));
    }
    Ok(())
}

pub async fn try_take_task_handler(
    AuthenticatedAgent(agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    let task_id = TaskId::from_url(id, cap)?;
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
    let task_id = TaskId::from_url(id.clone(), cap)?;
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

pub async fn post_task_progress_update(
    AuthenticatedAgent(mut agent): AuthenticatedAgent,
    State(app_state): State<Arc<AppState>>,
    Path((cap, id)): Path<(String, String)>,
    Json(report): Json<TaskUpdate>,
) -> Result<impl axum::response::IntoResponse, AppError> {
    // check urgent tasks first
    agent = app_state.storage.agents.update_agent_last_contact(agent)?;
    let task_id = TaskId::from_url(id.clone(), cap)?;
    if report.id != task_id {
        return Err(AppError::BadRequest(id));
    }
    info!("Agent {} updating task {task_id}", agent.uid_short);
    debug!("Update: {:?}", &report);

    let found = update_urgent_task(&app_state.urgent, report.clone(), task_id).await?;
    if !found {
        update_non_urgent_task(&app_state.storage.tasks, report).await?;
    }
    Ok(Json(json!({"message": "task report confirmed"})))
}
