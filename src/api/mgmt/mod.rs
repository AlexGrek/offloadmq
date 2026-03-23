pub mod storage;

use std::{collections::HashSet, env, sync::Arc};

use axum::{
    Json,
    extract::{Path, Query, State},
    response::IntoResponse,
};
use serde::Deserialize;
use serde_json::json;
use tracing::info;

use crate::{
    error::AppError,
    models::{Agent, ClientApiKey},
    schema::{self},
    state::AppState,
    utils::base_capability,
};

pub async fn list_agents(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let agents = state.storage.agents.list_all_agents();
    Ok(Json(agents))
}

pub async fn list_agents_online(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let agents = state.storage.agents.list_all_agents();
    Ok(Json(
        agents
            .into_iter()
            .filter(Agent::is_online)
            .collect::<Vec<Agent>>(),
    ))
}

pub async fn remove_agent(
    State(state): State<Arc<AppState>>,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    state.storage.delete_agent(&agent_id)?;
    Ok(Json(json!("Agent deleted")))
}

pub async fn version() -> impl IntoResponse {
    let v = env::var("APP_VERSION").unwrap_or_else(|_| "unknown".to_string());
    Json(json!({ "version": v }))
}

pub async fn capabilities_online(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let mut capabilities = HashSet::new();
    state
        .storage
        .agents
        .list_all_agents()
        .into_iter()
        .filter(Agent::is_online)
        .flat_map(|agent| agent.capabilities)
        .for_each(|cap| {
            capabilities.insert(base_capability(&cap).to_string());
        });
    Ok(Json(capabilities))
}

pub async fn capabilities_online_ext(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let mut capabilities: HashSet<String> = HashSet::new();
    state
        .storage
        .agents
        .list_all_agents()
        .into_iter()
        .filter(Agent::is_online)
        .flat_map(|agent| agent.capabilities)
        .for_each(|cap| {
            capabilities.insert(cap);
        });
    Ok(Json(capabilities))
}

pub async fn client_api_keys(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let keys = state.storage.client_keys.list_all();
    Ok(Json(keys))
}

pub async fn revoke_client_api_key(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let mut key = state
        .storage
        .client_keys
        .find_active(&id)?
        .ok_or_else(|| AppError::NotFound(id.clone()))?;
    key.is_revoked = true;
    state.storage.client_keys.update_key(&id, &key)?;
    Ok(Json(key))
}

pub async fn add_client_api_key(
    State(state): State<Arc<AppState>>,
    Json(new_key): Json<schema::CreateApiKeyRequest>,
) -> Result<impl IntoResponse, AppError> {
    let key: ClientApiKey = new_key.into();
    state.storage.client_keys.upsert_key(&key.key, &key)?;
    Ok(Json(key))
}

pub async fn list_tasks(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, AppError> {
    let tasks = state.urgent.tasks.read().await;
    let urgent: Vec<_> = tasks.iter().map(|entry| entry.1).collect();
    let urgent_assigned: Vec<_> = urgent
        .iter()
        .filter_map(|entry| entry.assigned_task.clone())
        .collect();
    let urgent_unassigned: Vec<_> = urgent
        .iter()
        .filter(|entry| entry.assigned_task.is_none())
        .map(|entry| entry.task.clone())
        .collect();
    let regular_assigned = state.storage.tasks.list_assigned_all()?;
    let regular_unassigned = state.storage.tasks.list_unassigned_all()?;
    Ok(Json(json!({"urgent": {"assigned": urgent_assigned,
                                "unassigned": urgent_unassigned},
                            "regular": {"assigned": regular_assigned,
                                "unassigned": regular_unassigned}})))
}

pub async fn reset_tasks(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    info!("Tasks reset triggered");
    state.storage.tasks.hard_clear()?;
    state.urgent.hard_clear().await;
    Ok(Json(json!({"result": "Reset successful"})))
}

pub async fn reset_agents(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    info!("Agents reset triggered");
    state.storage.agents.clear()?;
    Ok(Json(json!({"result": "Reset successful"})))
}

#[derive(Deserialize)]
pub struct ServiceLogsQuery {
    pub class: String,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

pub async fn list_service_messages(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ServiceLogsQuery>,
) -> Result<impl IntoResponse, AppError> {
    let limit = params.limit.unwrap_or(50).min(500);
    let (items, next_cursor) = state
        .storage
        .service_messages
        .list_by_class(&params.class, limit, params.cursor.as_deref())
        .map_err(AppError::Internal)?;

    Ok(Json(json!({
        "class": params.class,
        "items": items,
        "next_cursor": next_cursor,
        "count": items.len(),
    })))
}

pub async fn trigger_heuristics_cleanup(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, AppError> {
    let ttl_days = state.config.heuristics.ttl_days;
    let max_records = state.config.heuristics.max_records_per_runner_cap;

    let (deleted_by_age, deleted_by_limit) = state
        .storage
        .heuristics
        .cleanup(ttl_days, max_records)
        .map_err(AppError::Internal)?;

    info!(
        "Management: heuristics cleanup triggered, deleted {} by age, {} by limit",
        deleted_by_age, deleted_by_limit
    );
    Ok(Json(json!({
        "deleted_by_age": deleted_by_age,
        "deleted_by_limit": deleted_by_limit,
        "ttl_days": ttl_days,
        "max_records_per_runner_cap": max_records,
    })))
}