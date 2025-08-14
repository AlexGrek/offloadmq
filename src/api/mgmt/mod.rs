use std::{collections::HashSet, sync::Arc};

use axum::{
    Json,
    extract::{Path, State},
    response::IntoResponse,
};
use serde_json::json;

use crate::{
    error::AppError,
    models::{Agent, ClientApiKey},
    schema::{self},
    state::AppState,
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
        .map(|agent| agent.capabilities)
        .for_each(|cap_list| capabilities.extend(cap_list));
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
    Json(new_key): Json<schema::CreateApiKeyRequest>
) -> Result<impl IntoResponse, AppError> {
    let key: ClientApiKey = new_key.into();
    state.storage.client_keys.upsert_key(&key.key, &key)?;
    Ok(Json(key))
}
