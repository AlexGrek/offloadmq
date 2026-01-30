use std::sync::Arc;

use axum::{Json, Router, extract::State, middleware::from_fn_with_state, routing::*};
use log::info;
use offloadmq::{
    api::agent::{auth_agent, register_agent, update_agent_info, websocket_handler}, db::app_storage::AppStorage, preferences::init_config, state::AppState
};
use offloadmq::{middleware::auth::Auth, *};
use serde_json::{Value, json};
use tokio::{net::TcpListener, time};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing
    // tracing_subscriber::init();

    init_config(true, false);

    let config = config::AppConfig::from_env()?;
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    info!("Starting application with config:");
    info!("  Host: {}", config.host);
    info!("  Port: {}", config.port);
    info!("  Database path: {}", config.database_root_path);
    info!("  Agent API keys: {:?}", config.agent_api_keys);
    info!("  Client API keys: {:?}", config.client_api_keys);
    info!("  Management token: {}", config.management_token);

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
        .route("/agent/register", post(register_agent))
        .route("/agent/auth", post(auth_agent))
        // Agent WebSocket (auth via query params)
        .route("/private/agent/ws", get(websocket_handler))
        // Health check and stats
        .route("/health", get(health_check))
        .route("/stats", get(get_stats))
        .nest(
            "/private/agent",
            Router::new()
                .route("/ping", get(health_check))
                .route("/info/update", post(update_agent_info))
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
                .route(
                    "/task/progress/{cap}/{id}",
                    post(api::agent::post_task_progress_update),
                )
                .layer(from_fn_with_state(
                    shared_state.clone(),
                    middleware::jwt_auth_middleware_agent,
                )),
        )
        .nest(
            "/management",
            Router::new()
                .route(
                    "/capabilities/list/online",
                    get(api::mgmt::capabilities_online),
                )
                .route("/tasks/list", get(api::mgmt::list_tasks))
                .route("/tasks/reset", post(api::mgmt::reset_tasks))
                .route("/agents/list", get(api::mgmt::list_agents))
                .route("/agents/reset", post(api::mgmt::reset_agents))
                .route("/agents/list/online", get(api::mgmt::list_agents_online))
                .route("/agents/delete/{agent_id}", post(api::mgmt::remove_agent))
                .route("/client_api_keys/list", get(api::mgmt::client_api_keys))
                .route(
                    "/client_api_keys/update",
                    post(api::mgmt::add_client_api_key),
                )
                .route(
                    "/client_api_keys/revoke/{id}",
                    post(api::mgmt::revoke_client_api_key),
                )
                .layer(from_fn_with_state(
                    shared_state.clone(),
                    middleware::token_auth_middleware_mgmt,
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
                .route(
                    "/capabilities/online",
                    post(api::client::capabilities_online),
                )
                .layer(from_fn_with_state(
                    shared_state.clone(),
                    middleware::apikey_auth_middleware_user,
                )),
        )
        .with_state(shared_state.clone())
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(Any) // or Origin::exact("http://localhost:3000".parse().unwrap())
                .allow_methods(Any)
                .allow_headers(Any),
        );

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
