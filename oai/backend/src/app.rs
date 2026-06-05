use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
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

use crate::{middleware, routes, services::image_processing, state::AppState};

pub fn create_app(state: Arc<AppState>, static_dir: &str) -> Router {
    // All unmatched paths fall back to index.html for SPA client-side routing.
    let spa_fallback = ServeDir::new(static_dir)
        .not_found_service(ServeFile::new(format!("{static_dir}/index.html")));

    // Hashed Vite assets — no fallback so a missing chunk returns 404.
    let assets_dir = format!("{static_dir}/assets");

    let public = Router::new()
        .route("/api/health", get(routes::health::health))
        .route("/api/version", get(routes::health::version))
        .route("/api/auth/register", post(routes::auth::register))
        .route("/api/auth/login", post(routes::auth::login));

    let authenticated = Router::new()
        .route("/api/me", get(routes::auth::me))
        .route(
            "/api/auth/change_password",
            post(routes::auth::change_password),
        )
        .route("/api/admin/am_i_admin", get(routes::admin::am_i_admin))
        .route("/api/ws/chat", get(crate::ws::chat::ws_chat))
        .route("/api/chats", get(routes::chats::list_chats))
        .route("/api/chats", post(routes::chats::create_chat))
        .route("/api/chats/{id}", axum::routing::delete(routes::chats::delete_chat))
        .route(
            "/api/chats/{id}/system-prompt",
            axum::routing::patch(routes::chats::update_system_prompt),
        )
        .route(
            "/api/chats/{id}/last-model",
            axum::routing::patch(routes::chats::update_last_model),
        )
        .route("/api/chats/{id}/messages", get(routes::chats::get_messages))
        .route(
            "/api/chat/attachments/upload",
            post(routes::chat_attachments::upload_document)
                .layer(DefaultBodyLimit::max(
                    crate::services::chat_attachments::MAX_DOCUMENT_BYTES,
                )),
        )
        .route(
            "/api/chat/attachments/image",
            post(routes::chat_attachments::create_image_attachment),
        )
        .route(
            "/api/chat/attachments/reference",
            post(routes::chat_attachments::reference_document),
        )
        .route(
            "/api/chat/attachments/documents",
            get(routes::chat_attachments::list_documents),
        )
        .route(
            "/api/chat/attachments/{id}/download",
            get(routes::chat_attachments::download_document),
        )
        .route("/api/prompts/{bucket}", get(routes::prompts::list_library))
        .route("/api/prompts/{bucket}/star", post(routes::prompts::star))
        .route(
            "/api/prompt-entries/{id}",
            axum::routing::patch(routes::prompts::update_entry)
                .delete(routes::prompts::delete_entry),
        )
        .route("/api/files", get(routes::files::list_files))
        .route("/api/files/properties", get(routes::files::get_file_properties))
        .route("/api/files/cleanup", post(routes::files::cleanup_files))
        .route(
            "/api/images/upload",
            post(routes::images::upload_input_image)
                .layer(DefaultBodyLimit::max(image_processing::MAX_UPLOAD_BYTES)),
        )
        .route("/api/images/jobs", post(routes::images::start_job))
        .route("/api/images/jobs", get(routes::images::list_jobs))
        .route("/api/images/capabilities", get(routes::images::list_imggen_capabilities))
        .route(
            "/api/images/jobs/{id}",
            get(routes::images::get_job).delete(routes::images::delete_job),
        )
        .route("/api/images/jobs/{id}/poll", post(routes::images::poll_job))
        .route("/api/images/jobs/{id}/cancel", post(routes::images::cancel_job))
        .route("/api/images/jobs/{id}/retry", post(routes::images::retry_job))
        .route(
            "/api/images/files/{id}",
            get(routes::images::get_image).delete(routes::images::delete_image),
        )
        .route(
            "/api/images/files/{id}/thumbnail",
            get(routes::images::get_image_thumbnail),
        )
        .route(
            "/api/images/files/{id}/starred",
            get(routes::images::get_image_starred).patch(routes::images::set_image_starred),
        )
        .route("/api/progress/running", get(routes::progress::running_jobs))
        .route("/api/runners/online", get(routes::runners::list_online))
        .route(
            "/api/tasks/cancel/{cap}/{id}",
            post(routes::tasks::cancel_offload_task),
        )
        .route("/api/debug/offload_poll", post(routes::debug::offload_poll))
        .route(
            "/api/describe/capabilities",
            get(routes::describe::list_capabilities),
        )
        .route("/api/describe/jobs", post(routes::describe::start_job))
        .route("/api/describe/jobs", get(routes::describe::list_jobs))
        .route(
            "/api/describe/jobs/{id}",
            get(routes::describe::get_job).delete(routes::describe::delete_job),
        )
        .route("/api/describe/jobs/{id}/poll", post(routes::describe::poll_job))
        .route("/api/describe/jobs/{id}/cancel", post(routes::describe::cancel_job))
        .route("/api/describe/jobs/{id}/retry", post(routes::describe::retry_job))
        .route(
            "/api/nude-detect/availability",
            get(routes::nude_detect::availability),
        )
        .route("/api/nude-detect/jobs", post(routes::nude_detect::start_job))
        .route("/api/nude-detect/jobs", get(routes::nude_detect::list_jobs))
        .route(
            "/api/nude-detect/jobs/{id}",
            get(routes::nude_detect::get_job).delete(routes::nude_detect::delete_job),
        )
        .route("/api/nude-detect/jobs/{id}/poll", post(routes::nude_detect::poll_job))
        .route("/api/nude-detect/jobs/{id}/cancel", post(routes::nude_detect::cancel_job))
        .route("/api/nude-detect/jobs/{id}/retry", post(routes::nude_detect::retry_job))
        .route("/api/tts/capabilities", get(routes::tts::list_capabilities))
        .route("/api/tts/jobs", post(routes::tts::start_job))
        .route("/api/tts/jobs", get(routes::tts::list_jobs))
        .route(
            "/api/tts/jobs/{id}",
            get(routes::tts::get_job).delete(routes::tts::delete_job),
        )
        .route("/api/tts/jobs/{id}/poll", post(routes::tts::poll_job))
        .route("/api/tts/jobs/{id}/cancel", post(routes::tts::cancel_job))
        .route("/api/tts/jobs/{id}/retry", post(routes::tts::retry_job))
        .route("/api/tts/jobs/{id}/audio", get(routes::tts::get_audio))
        .route(
            "/api/music-gen/capabilities",
            get(routes::music_generation::list_capabilities),
        )
        .route("/api/music-gen/jobs", post(routes::music_generation::start_job))
        .route("/api/music-gen/jobs", get(routes::music_generation::list_jobs))
        .route(
            "/api/music-gen/jobs/{id}",
            get(routes::music_generation::get_job)
                .delete(routes::music_generation::delete_job),
        )
        .route(
            "/api/music-gen/jobs/{id}/poll",
            post(routes::music_generation::poll_job),
        )
        .route(
            "/api/music-gen/jobs/{id}/cancel",
            post(routes::music_generation::cancel_job),
        )
        .route(
            "/api/music-gen/jobs/{id}/retry",
            post(routes::music_generation::retry_job),
        )
        .route(
            "/api/music-gen/jobs/{id}/audio/{track}",
            get(routes::music_generation::get_audio),
        )
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
        .route("/api/admin/k8s/self/pod", get(routes::admin::admin_k8s_self_pod))
        .route("/api/admin/k8s/self/logs", get(routes::admin::admin_k8s_self_logs))
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
