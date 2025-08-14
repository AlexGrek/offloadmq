use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, State},
    middleware::from_fn_with_state,
    routing::*,
};
use hyper::StatusCode;
use log::{info, warn};
use offloadmq::{
    api::agent::{auth_agent, register_agent, update_agent_info},
    db::app_storage::AppStorage,
    models::Agent,
    state::AppState,
};
use offloadmq::{middleware::auth::Auth, *};
use serde_json::{Value, json};
use tokio::{net::TcpListener, time};
use tower_http::trace::TraceLayer;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    // tracing_subscriber::init();

    let config = config::AppConfig::from_env()?;
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    info!("Starting application with config:");
    info!("  Host: {}", config.host);
    info!("  Port: {}", config.port);
    info!("  Database path: {}", config.database_root_path);
    info!("  Agent API keys: {:?}", config.agent_api_keys);
    info!("  Client API keys: {:?}", config.client_api_keys);

    // Initialize storage with config path and default 120s TTL
    let app_storage =
        AppStorage::new(&config.database_root_path).expect("Failed to initialize storage");

    let auth = Auth::new(config.jwt_secret.as_bytes());
    // Create app state
    let app_state = AppState::new(app_storage, config.clone(), auth);
    let shared_state = Arc::new(app_state);
    shared_state
        .storage
        .client_keys
        .initialize_from_list(&shared_state.config.client_api_keys)?;

    // Build the application router
    let app = Router::new()
        // Agent routes
        .route("/agents", get(list_agents))
        .route("/agent/register", post(register_agent))
        .route("/agent/auth", post(auth_agent))
        .route("/agent/update", post(update_agent_info))
        .route("/agents/{id}", get(get_agent))
        .route("/agents/{id}", put(update_agent))
        .route("/agents/{id}", delete(delete_agent))
        // Health check and stats
        .route("/health", get(health_check))
        .route("/stats", get(get_stats))
        .nest(
            "/private/agent",
            Router::new()
                .route("/ping", get(health_check))
                .route(
                    "/task/poll_urgent",
                    get(api::agent::fetch_task_urgent_handler),
                )
                .route("/task/poll", get(api::agent::fetch_task_non_urgent_handler))
                .route("/take/{cap}/{id}", post(api::agent::try_take_task_handler))
                .route(
                    "/task/resolve/{cap}/{id}",
                    post(api::agent::post_task_resolution),
                )
                .layer(from_fn_with_state(
                    shared_state.clone(),
                    middleware::jwt_auth_middleware_agent,
                )),
        )
        .nest(
            "/api",
            Router::new()
                .route("/ping", get(health_check))
                .route("/task/submit", post(api::client::submit_task))
                .route("/task/poll/{cap}/{id}", post(api::client::poll_task_status))
                .route(
                    "/task/submit_blocking",
                    post(api::client::submit_task_blocking),
                )
                .layer(from_fn_with_state(
                    shared_state.clone(),
                    middleware::apikey_auth_middleware_user,
                )),
        )
        .with_state(shared_state.clone())
        .layer(TraceLayer::new_for_http());

    // Start the server
    let bind_address = format!("{}:{}", config.host, config.port);
    let listener = TcpListener::bind(&bind_address).await?;
    info!("Server starting on http://{}", bind_address);

    tokio::spawn(async move {
        let mut interval = time::interval(time::Duration::from_secs(120));
        loop {
            interval.tick().await;
            shared_state.storage.agents.log_online_agents();
        }
    });

    axum::serve(listener, app).await?;

    Ok(())
}

// Agent handlers
async fn list_agents(State(state): State<Arc<AppState>>) -> Result<Json<Value>, StatusCode> {
    // Note: This would need a list_all_agents method in AppStorage
    // For now, return a placeholder
    let stats = state.storage.get_agent_cache_stats();
    Ok(Json(json!({
        "message": "List agents endpoint",
        "cached_agents": stats.0,
        "cached_tokens": stats.1
    })))
}

async fn get_agent(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Agent>, StatusCode> {
    match state.storage.get_agent(&id) {
        Some(agent) => Ok(Json(agent)),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn update_agent(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(mut agent): Json<Agent>,
) -> Result<Json<Value>, StatusCode> {
    // Ensure the agent ID matches the path parameter
    agent.uid = id;

    match state.storage.update_agent(agent) {
        Ok(()) => Ok(Json(json!({
            "message": "Agent updated successfully"
        }))),
        Err(e) => {
            warn!("Failed to update agent: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

async fn delete_agent(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    match state.storage.delete_agent(&id) {
        Ok(()) => Ok(Json(json!({
            "message": "Agent deleted successfully"
        }))),
        Err(e) => {
            warn!("Failed to delete agent: {}", e);
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

// Utility handlers
async fn health_check(State(state): State<Arc<AppState>>) -> Json<Value> {
    let stats = state.storage.get_agent_cache_stats();
    Json(json!({
        "status": "healthy",
        "cached_agents": stats.0,
        "cached_tokens": stats.1,
        "timestamp": chrono::Utc::now()
    }))
}

async fn get_stats(State(state): State<Arc<AppState>>) -> Json<Value> {
    // Trigger cleanup and get fresh stats
    state.storage.cleanup_expired();
    let stats = state.storage.get_agent_cache_stats();

    Json(json!({
        "cache_stats": {
            "agents": stats.0,
            "tokens": stats.1
        },
        "storage_paths": {
            "agents": "./data/agents",
            "tasks": "./data/tasks"
        }
    }))
}
