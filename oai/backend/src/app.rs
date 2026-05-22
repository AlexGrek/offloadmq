use std::sync::Arc;

use axum::{
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        Method,
    },
    middleware::from_fn_with_state,
    routing::{get, post},
    Router,
};
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use crate::{middleware, routes, state::AppState};

pub fn create_app(state: Arc<AppState>, static_dir: &str) -> Router {
    // All unmatched paths fall back to index.html for SPA client-side routing.
    let spa_fallback = ServeDir::new(static_dir)
        .not_found_service(ServeFile::new(format!("{static_dir}/index.html")));

    // Hashed Vite assets — no fallback so a missing chunk returns 404.
    let assets_dir = format!("{static_dir}/assets");

    let public = Router::new()
        .route("/api/health", get(routes::health::health))
        .route("/api/auth/register", post(routes::auth::register))
        .route("/api/auth/login", post(routes::auth::login));

    let authenticated = Router::new()
        .route("/api/me", get(routes::auth::me))
        .route("/api/admin/am_i_admin", get(routes::admin::am_i_admin))
        .route("/api/ws/chat", get(crate::ws::chat::ws_chat))
        .route("/api/chats", get(routes::chats::list_chats))
        .route("/api/chats", post(routes::chats::create_chat))
        .route("/api/chats/{id}", axum::routing::delete(routes::chats::delete_chat))
        .route("/api/chats/{id}/messages", get(routes::chats::get_messages))
        .route("/api/files", get(routes::files::list_files))
        .route("/api/images/upload", post(routes::images::upload_input_image))
        .route("/api/images/jobs", post(routes::images::start_job))
        .route("/api/images/jobs", get(routes::images::list_jobs))
        .route("/api/images/capabilities", get(routes::images::list_imggen_capabilities))
        .route("/api/images/jobs/{id}", get(routes::images::get_job))
        .route("/api/images/jobs/{id}/poll", post(routes::images::poll_job))
        .route("/api/images/files/{id}", get(routes::images::get_image))
        .layer(from_fn_with_state(state.clone(), middleware::jwt_auth_middleware));

    let admin = Router::new()
        .route("/api/admin/settings", get(routes::admin::get_settings))
        .route("/api/admin/settings", post(routes::admin::update_settings))
        .route("/api/admin/check_connection", post(routes::admin::check_connection))
        .route("/api/admin/images/jobs", get(routes::admin::admin_list_image_jobs))
        .route("/api/admin/images/jobs/{id}", get(routes::admin::admin_get_image_job))
        .route("/api/admin/images/jobs/{id}/reconcile", post(routes::admin::admin_reconcile_image_job))
        .route("/api/admin/images/files", get(routes::admin::admin_list_image_files))
        .route("/api/admin/images/events", get(routes::admin::admin_list_image_events))
        .route("/api/admin/images/offload_tasks", get(routes::admin::admin_list_image_offload_tasks))
        .route("/api/admin/images/worker_logs", get(routes::admin::admin_list_image_worker_logs))
        .layer(from_fn_with_state(state.clone(), middleware::admin_auth_middleware));

    Router::new()
        .merge(public)
        .merge(authenticated)
        .merge(admin)
        .nest_service("/assets", ServeDir::new(&assets_dir))
        .fallback_service(spa_fallback)
        .with_state(state.clone())
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin([
                    "http://localhost:5173".parse().unwrap(),
                    "http://127.0.0.1:5173".parse().unwrap(),
                    "http://localhost:5174".parse().unwrap(),
                    "http://127.0.0.1:5174".parse().unwrap(),
                    "https://oai.alexgr.space".parse().unwrap(),
                ])
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::PATCH,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([CONTENT_TYPE, AUTHORIZATION])
                .allow_credentials(true),
        )
}
