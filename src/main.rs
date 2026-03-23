use std::sync::Arc;

use axum::{Json, Router, extract::State, middleware::from_fn_with_state, routing::*};
use log::info;
use offloadmq::{
    api::agent::{auth_agent, register_agent, update_agent_info, websocket_handler},
    db::app_storage::AppStorage,
    preferences::init_config,
    state::AppState,
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
    info!("  Storage backend: {}", config.storage.backend);

    let app_storage = AppStorage::new(&config.database_root_path, &config.storage)
        .expect("Failed to initialize storage");

    let auth = Auth::new(config.jwt_secret.as_bytes());
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
        .route("/version", get(api::mgmt::version))
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
                .route(
                    "/bucket/{bucket_uid}/stat",
                    get(api::agent::bucket_stat),
                )
                .route(
                    "/bucket/{bucket_uid}/file/{file_uid}",
                    get(api::agent::download_bucket_file),
                )
                .route(
                    "/bucket/{bucket_uid}/upload",
                    post(api::agent::upload_to_bucket),
                )
                .layer(from_fn_with_state(
                    shared_state.clone(),
                    middleware::jwt_auth_middleware_agent,
                )),
        )
        .nest(
            "/management",
            Router::new()
                .route("/version", get(api::mgmt::version))
                .route(
                    "/capabilities/list/online",
                    get(api::mgmt::capabilities_online),
                )
                .route(
                    "/capabilities/list/online_ext",
                    get(api::mgmt::capabilities_online_ext),
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
                .route(
                    "/storage/buckets",
                    get(api::mgmt::storage::list_all_buckets)
                        .delete(api::mgmt::storage::purge_all_buckets),
                )
                .route(
                    "/storage/quotas",
                    get(api::mgmt::storage::get_quotas),
                )
                .route(
                    "/storage/bucket/{bucket_uid}",
                    delete(api::mgmt::storage::delete_bucket),
                )
                .route(
                    "/storage/key/{api_key}/buckets",
                    delete(api::mgmt::storage::delete_key_buckets),
                )
                .route(
                    "/storage/cleanup/trigger",
                    post(api::mgmt::storage::trigger_storage_cleanup),
                )
                .route(
                    "/heuristics/cleanup/trigger",
                    post(api::mgmt::trigger_heuristics_cleanup),
                )
                .route(
                    "/service_logs",
                    get(api::mgmt::list_service_messages),
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
        // Storage API — uses X-API-Key header auth (supports multipart + GET + DELETE)
        .nest(
            "/api/storage",
            Router::new()
                .route("/limits", get(api::client::storage::get_limits))
                .route("/buckets", get(api::client::storage::list_buckets))
                .route("/bucket/create", post(api::client::storage::create_bucket))
                .route(
                    "/bucket/{bucket_uid}/upload",
                    post(api::client::storage::upload_file),
                )
                .route(
                    "/bucket/{bucket_uid}/stat",
                    get(api::client::storage::bucket_stat),
                )
                .route(
                    "/bucket/{bucket_uid}/file/{file_uid}/hash",
                    get(api::client::storage::file_hash),
                )
                .route(
                    "/bucket/{bucket_uid}/file/{file_uid}",
                    get(api::client::storage::download_file)
                        .delete(api::client::storage::delete_file),
                )
                .route(
                    "/bucket/{bucket_uid}",
                    delete(api::client::storage::delete_bucket),
                )
                .layer(from_fn_with_state(
                    shared_state.clone(),
                    middleware::apikey_header_auth_middleware_storage,
                )),
        )
        .with_state(shared_state.clone())
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );

    // Start the server
    let bind_address = format!("{}:{}", config.host, config.port);
    let listener = TcpListener::bind(&bind_address).await?;
    info!("Server starting on http://{}", bind_address);

    // Background: log online agents every 120 s
    {
        let state = shared_state.clone();
        tokio::spawn(async move {
            let mut interval = time::interval(time::Duration::from_secs(120));
            loop {
                interval.tick().await;
                state.storage.agents.log_online_agents();
            }
        });
    }

    // Background: purge expired buckets on startup and then every 3 hours
    {
        let state = shared_state.clone();
        tokio::spawn(async move {
            let interval_secs = 3 * 60 * 60; // 3 hours
            let mut interval = time::interval(time::Duration::from_secs(interval_secs));
            loop {
                interval.tick().await;
                let ttl = state.config.storage.bucket_ttl_minutes;
                let expired = state.storage.buckets.list_expired_buckets(ttl);
                if expired.is_empty() {
                    continue;
                }
                info!("Storage cleanup: purging {} expired bucket(s)", expired.len());
                let mut deleted = 0usize;
                let mut errors = 0usize;
                for bucket in &expired {
                    let mut ok = true;
                    if let Err(e) = state.storage.file_store.delete_bucket(&bucket.uid).await {
                        log::warn!("Failed to delete bucket files {}: {}", bucket.uid, e);
                        ok = false;
                    }
                    if let Err(e) = state
                        .storage
                        .buckets
                        .delete_bucket(&bucket.uid, &bucket.api_key)
                    {
                        log::warn!("Failed to delete bucket metadata {}: {}", bucket.uid, e);
                        ok = false;
                    }
                    if ok { deleted += 1; } else { errors += 1; }
                }
                let _ = state.storage.service_messages.push(
                    "bg",
                    "storage-cleanup-job",
                    serde_json::json!({
                        "expired_found": expired.len(),
                        "deleted": deleted,
                        "errors": errors,
                    }),
                );
            }
        });
    }

    // Background: clean up old heuristic records on startup and periodically
    {
        let state = shared_state.clone();
        tokio::spawn(async move {
            let mut first_run = true;
            loop {
                // On first run, clean up immediately
                if !first_run {
                    // Generate random interval between min and max hours
                    let min_hours = state.config.heuristics.cleanup_interval_min_hours as u64;
                    let max_hours = state.config.heuristics.cleanup_interval_max_hours as u64;
                    let random_hours = if min_hours == max_hours {
                        min_hours
                    } else {
                        use rand::Rng;
                        let mut rng = rand::rng();
                        rng.random_range(min_hours..=max_hours)
                    };
                    let interval_secs = random_hours * 60 * 60;
                    let mut interval = time::interval(time::Duration::from_secs(interval_secs));
                    interval.tick().await;
                }
                first_run = false;

                let ttl_days = state.config.heuristics.ttl_days;
                let max_records = state.config.heuristics.max_records_per_runner_cap;

                match state.storage.heuristics.cleanup(ttl_days, max_records) {
                    Ok((deleted_by_age, deleted_by_limit)) => {
                        if deleted_by_age > 0 || deleted_by_limit > 0 {
                            info!(
                                "Heuristics cleanup: deleted {} records by age, {} by limit (ttl={}d, max={})",
                                deleted_by_age, deleted_by_limit, ttl_days, max_records
                            );
                        }
                        let _ = state.storage.service_messages.push(
                            "bg",
                            "heuristics-cleanup-job",
                            serde_json::json!({
                                "deleted_by_age": deleted_by_age,
                                "deleted_by_limit": deleted_by_limit,
                                "ttl_days": ttl_days,
                                "max_records_per_runner_cap": max_records,
                            }),
                        );
                    }
                    Err(e) => {
                        log::warn!("Heuristics cleanup failed: {}", e);
                        let _ = state.storage.service_messages.push(
                            "bg",
                            "heuristics-cleanup-job",
                            serde_json::json!({ "error": e.to_string() }),
                        );
                    }
                }
            }
        });
    }

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
