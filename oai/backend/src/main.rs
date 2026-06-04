use std::sync::Arc;

use anyhow::Result;

mod app;
mod db;
mod error;
mod jobs;
mod middleware;
mod offload;
mod routes;
mod services;
mod snowflake;
mod state;
mod storage;
mod ws;

use middleware::auth::Auth;
use snowflake::SnowflakeGenerator;
use state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let jwt_secret =
        std::env::var("JWT_SECRET").unwrap_or_else(|_| "dev-secret-change-in-prod".into());
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "../frontend/dist".into());
    let addr = std::env::var("SERVER_ADDRESS").unwrap_or_else(|_| "0.0.0.0:3000".into());

    let db = db::connect(&database_url).await?;
    let auth = Auth::new(jwt_secret.as_bytes(), 30);
    let storage = storage::build_operator()?;
    let snowflake = SnowflakeGenerator::new(1);

    ensure_root_admin(&db, &auth, &snowflake).await?;
    seed_settings_from_env(&db).await?;

    let http = reqwest::Client::new();
    let state = Arc::new(AppState { db, auth, snowflake, storage, http });
    jobs::image_pipeline_worker::spawn(state.clone());
    jobs::image_analysis_worker::spawn(state.clone());
    jobs::nude_detect_worker::spawn(state.clone());
    jobs::llm_capability_cleanup_worker::spawn(state.clone());
    jobs::chat_worker::spawn(state.clone());
    jobs::tts_worker::spawn(state.clone());
    jobs::music_generation_worker::spawn(state.clone());

    let app = app::create_app(state, &static_dir);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("listening on {addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn ensure_root_admin(
    db: &sea_orm::DatabaseConnection,
    auth: &Auth,
    snowflake: &SnowflakeGenerator,
) -> Result<()> {
    if db::users::find_by_login(db, "root").await?.is_some() {
        return Ok(());
    }

    let password = std::env::var("ROOT_ADMIN_PASSWORD").unwrap_or_else(|_| "000000".into());

    let hash = auth.hash_password(&password)?;
    let id = snowflake.next_id();
    db::users::create_admin(db, id, "root", hash).await?;

    println!("=================================================");
    println!(" Root admin created  |  login: root  |  password: {password}");
    println!("=================================================");

    Ok(())
}

async fn seed_settings_from_env(db: &sea_orm::DatabaseConnection) -> Result<()> {
    let env_client = std::env::var("OFFLOAD_MQ_CLIENT_KEY").ok();
    let env_mgmt = std::env::var("OFFLOAD_MQ_MGMT_TOKEN").ok();

    if env_client.is_none() && env_mgmt.is_none() {
        return Ok(());
    }

    let settings = db::app_settings::get(db).await?;

    let needs_client = settings.client_api_token.is_none() && env_client.is_some();
    let needs_mgmt = settings.management_api_token.is_none() && env_mgmt.is_some();

    if !needs_client && !needs_mgmt {
        return Ok(());
    }

    let new_client = if needs_client { env_client } else { settings.client_api_token };
    let new_mgmt = if needs_mgmt { env_mgmt } else { settings.management_api_token };

    db::app_settings::update(db, settings.offloadmq_url, new_client, new_mgmt).await?;
    tracing::info!("app settings seeded from env vars");
    Ok(())
}
