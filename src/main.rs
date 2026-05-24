use std::sync::Arc;

use axum::{Json, Router, extract::{DefaultBodyLimit, State}, middleware::from_fn_with_state, routing::*};
use log::info;
use offloadmq::{
    api::agent::{agent_ping, auth_agent, register_agent, update_agent_info, websocket_handler},
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
                .route("/ping", get(agent_ping))
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
                ))
                .layer(DefaultBodyLimit::max(
                    shared_state.config.storage.bucket_size_bytes as usize,
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
                    "/heuristics/records",
                    get(api::mgmt::heuristics::list_records),
                )
                .route(
                    "/heuristics/stats/runners",
                    get(api::mgmt::heuristics::list_runner_stats),
                )
                .route(
                    "/heuristics/stats/machines",
                    get(api::mgmt::heuristics::list_machine_stats),
                )
                .route(
                    "/heuristics/estimate_duration",
                    get(api::mgmt::heuristics::estimate_duration),
                )
                .route(
                    "/heuristics/cleanup/trigger",
                    post(api::mgmt::trigger_heuristics_cleanup),
                )
                .route(
                    "/agents/cleanup/trigger",
                    post(api::mgmt::trigger_stale_agents_cleanup),
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
                    "/task/cancel/{cap}/{id}",
                    post(api::client::cancel_task),
                )
                .route(
                    "/capabilities/online",
                    post(api::client::capabilities_online),
                )
                .route(
                    "/capabilities/list/online_ext",
                    post(api::client::capabilities_online_ext),
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
                ))
                .layer(DefaultBodyLimit::max(
                    shared_state.config.storage.bucket_size_bytes as usize,
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
                        .await
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
                    // Generate random delay between min and max hours
                    let min_hours = state.config.heuristics.cleanup_interval_min_hours as u64;
                    let max_hours = state.config.heuristics.cleanup_interval_max_hours as u64;
                    let random_hours = if min_hours == max_hours {
                        min_hours
                    } else {
                        use rand::Rng;
                        let mut rng = rand::rng();
                        rng.random_range(min_hours..=max_hours)
                    };
                    let sleep_secs = random_hours * 60 * 60;
                    time::sleep(time::Duration::from_secs(sleep_secs)).await;
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

    // Background: clean up stale agents on startup and periodically
    {
        let state = shared_state.clone();
        tokio::spawn(async move {
            let mut first_run = true;
            loop {
                // On first run, clean up immediately
                if !first_run {
                    // Generate random delay between min and max hours
                    let min_hours = state.config.stale_agents.cleanup_interval_min_hours as u64;
                    let max_hours = state.config.stale_agents.cleanup_interval_max_hours as u64;
                    let random_hours = if min_hours == max_hours {
                        min_hours
                    } else {
                        use rand::Rng;
                        let mut rng = rand::rng();
                        rng.random_range(min_hours..=max_hours)
                    };
                    let sleep_secs = random_hours * 60 * 60;
                    time::sleep(time::Duration::from_secs(sleep_secs)).await;
                }
                first_run = false;

                let ttl_days = state.config.stale_agents.ttl_days;

                match state.storage.agents.cleanup_stale_agents(ttl_days).await {
                    Ok(deleted) => {
                        if deleted > 0 {
                            info!(
                                "Stale agents cleanup: deleted {} agent(s) (ttl={}d)",
                                deleted, ttl_days
                            );
                        }
                        let _ = state.storage.service_messages.push(
                            "bg",
                            "stale-agents-cleanup-job",
                            serde_json::json!({
                                "deleted": deleted,
                                "ttl_days": ttl_days,
                            }),
                        );
                    }
                    Err(e) => {
                        log::warn!("Stale agents cleanup failed: {}", e);
                        let _ = state.storage.service_messages.push(
                            "bg",
                            "stale-agents-cleanup-job",
                            serde_json::json!({ "error": e.to_string() }),
                        );
                    }
                }
            }
        });
    }

    // Background: maintain persistent (non-urgent) task state every 30 s.
    // - Unassigned tasks past maxWaitSecs or timeoutSecs are moved to Failed.
    // - Assigned tasks past timeoutSecs are set to CancelRequested so the
    //   executing agent receives HTTP 499 on its next progress/resolve call.
    // - CancelRequested tasks unacknowledged past the grace window are failed.
    // - Tasks held by an offline, silent agent are recovered (failed).
    {
        // How long to wait after requesting cancel before presuming the agent
        // is dead and force-failing the task.
        const CANCEL_ACK_GRACE_SECS: i64 = 120;
        // How long a task may go untouched by an offline agent before it is
        // treated as orphaned. Long enough not to disturb legitimately running
        // tasks that report progress infrequently.
        const ORPHAN_SILENCE_SECS: i64 = 30 * 60;

        let state = shared_state.clone();
        tokio::spawn(async move {
            let mut interval = time::interval(time::Duration::from_secs(30));
            loop {
                interval.tick().await;
                match state.storage.tasks.expire_timed_out_unassigned() {
                    Ok(n) if n > 0 => {
                        info!("Task timeout: failed {} unassigned task(s) past wait/total deadline", n);
                    }
                    Err(e) => log::warn!("Task timeout check (unassigned) error: {}", e),
                    _ => {}
                }
                match state.storage.tasks.cancel_timed_out_assigned() {
                    Ok(n) if n > 0 => {
                        info!("Task timeout: sent cancel signal to {} assigned task(s) past total deadline", n);
                    }
                    Err(e) => log::warn!("Task timeout check (assigned) error: {}", e),
                    _ => {}
                }
                match state.storage.tasks.fail_stale_cancel_requested(CANCEL_ACK_GRACE_SECS) {
                    Ok(n) if n > 0 => {
                        info!("Task cleanup: failed {} cancel-requested task(s) the agent never acknowledged", n);
                    }
                    Err(e) => log::warn!("Cancel-requested escalation error: {}", e),
                    _ => {}
                }
                let agents = &state.storage.agents;
                match state.storage.tasks.recover_orphaned_assigned(
                    ORPHAN_SILENCE_SECS,
                    |agent_id| agents.get_agent(agent_id).map(|a| a.is_online()).unwrap_or(false),
                ) {
                    Ok(n) if n > 0 => {
                        info!("Task cleanup: recovered {} orphaned task(s) from offline agents", n);
                    }
                    Err(e) => log::warn!("Orphan recovery error: {}", e),
                    _ => {}
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
