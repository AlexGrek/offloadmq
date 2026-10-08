//! Deletes dead MCP OAuth state (`db::oauth::cleanup`): expired authorization codes,
//! long-expired or revoked tokens and grants, and dynamically registered clients that
//! never completed a sign-in. Registration is unauthenticated by design (RFC 7591, as
//! Claude's connector requires), so without this the client table would only grow.
//! Runs at startup and then hourly (`OAUTH_CLEANUP_TICK_SECS`).

use std::{sync::Arc, time::Duration};

use crate::{db::oauth, error::AppError, state::AppState};

const DEFAULT_TICK_SECS: u64 = 3600;
/// Expired/revoked tokens and dead grants are kept this long for debugging.
const DEAD_RETENTION: chrono::Duration = chrono::Duration::days(7);
/// A registered client with no grant after this long is abandoned.
const UNUSED_CLIENT_RETENTION: chrono::Duration = chrono::Duration::hours(24);

pub fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        let tick_secs = std::env::var("OAUTH_CLEANUP_TICK_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_TICK_SECS);
        let mut ticker = tokio::time::interval(Duration::from_secs(tick_secs));
        loop {
            ticker.tick().await;
            if let Err(e) = run_pass(&state).await {
                tracing::warn!("oauth cleanup pass failed: {e}");
            }
        }
    });
}

async fn run_pass(state: &AppState) -> Result<(), AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let stats = oauth::cleanup(
        &state.db,
        now - DEAD_RETENTION,
        now - UNUSED_CLIENT_RETENTION,
    )
    .await?;
    if stats.codes + stats.tokens + stats.grants + stats.clients > 0 {
        tracing::info!(
            codes = stats.codes,
            tokens = stats.tokens,
            grants = stats.grants,
            clients = stats.clients,
            "oauth cleanup"
        );
    }
    Ok(())
}
