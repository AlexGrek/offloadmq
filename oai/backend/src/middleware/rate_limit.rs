//! Per-IP rate limiting for the credential endpoints (`register`, `login`,
//! `change_password`). Each of those runs a bcrypt verify/hash, so an unthrottled
//! client can both brute-force passwords and burn CPU.
//!
//! Configuration (all optional):
//! - `AUTH_RATE_LIMIT_BURST` — requests a client may send back to back (default 10)
//! - `AUTH_RATE_LIMIT_REPLENISH_SECS` — seconds to regain one request (default 6)
//! - `AUTH_RATE_LIMIT_TRUST_FORWARDED` — key on the proxy's `X-Forwarded-For` hop
//!   instead of the socket peer (default `true`; set `false` if the backend is
//!   exposed directly rather than behind Traefik)
//! - `AUTH_RATE_LIMIT_DISABLED` — `1`/`true` turns the limiter off (integration tests)

use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use axum::{
    Router,
    extract::ConnectInfo,
    http::{HeaderMap, Request},
};
use tower_governor::{
    GovernorError, GovernorLayer, governor::GovernorConfigBuilder, key_extractor::KeyExtractor,
};

const DEFAULT_BURST: u32 = 10;
const DEFAULT_REPLENISH_SECS: u64 = 6;
/// How often stale per-IP entries are dropped from the limiter's map.
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

fn env_num<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// Identifies the client by IP.
///
/// Behind a reverse proxy the socket peer is always the proxy, so the real client
/// has to come from `X-Forwarded-For`. The proxy *appends* the address it saw, so
/// the **last** entry is the one we can trust; earlier entries are whatever the
/// client chose to send. (`tower_governor`'s own `SmartIpKeyExtractor` takes the
/// first entry, which would let a client dodge the limit by rotating a fake header.)
#[derive(Clone, Copy, Debug)]
pub struct ClientIpKeyExtractor {
    trust_forwarded: bool,
}

impl KeyExtractor for ClientIpKeyExtractor {
    type Key = IpAddr;

    fn extract<T>(&self, req: &Request<T>) -> Result<Self::Key, GovernorError> {
        let forwarded = self
            .trust_forwarded
            .then(|| last_forwarded_for(req.headers()))
            .flatten();
        if let Some(ip) = forwarded {
            return Ok(ip);
        }
        req.extensions()
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip())
            .ok_or(GovernorError::UnableToExtractKey)
    }
}

/// Rightmost parseable address across all `X-Forwarded-For` header lines.
fn last_forwarded_for(headers: &HeaderMap) -> Option<IpAddr> {
    headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(','))
        .filter_map(|part| part.trim().parse::<IpAddr>().ok())
        .next_back()
}

/// Wraps `routes` in the auth rate limiter, configured from the environment.
/// Returns the router unchanged when `AUTH_RATE_LIMIT_DISABLED` is set.
///
/// Must be called inside a Tokio runtime (it spawns the map-cleanup task), and the
/// server must be started with `into_make_service_with_connect_info::<SocketAddr>()`
/// so the peer address fallback exists.
pub fn limit<S>(routes: Router<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    if env_flag("AUTH_RATE_LIMIT_DISABLED", false) {
        tracing::warn!("auth rate limiting is DISABLED (AUTH_RATE_LIMIT_DISABLED)");
        return routes;
    }

    let burst = env_num("AUTH_RATE_LIMIT_BURST", DEFAULT_BURST);
    let replenish_secs = env_num("AUTH_RATE_LIMIT_REPLENISH_SECS", DEFAULT_REPLENISH_SECS);
    let extractor = ClientIpKeyExtractor {
        trust_forwarded: env_flag("AUTH_RATE_LIMIT_TRUST_FORWARDED", true),
    };
    limit_with(routes, burst, replenish_secs, extractor)
}

fn limit_with<S>(
    routes: Router<S>,
    burst: u32,
    replenish_secs: u64,
    extractor: ClientIpKeyExtractor,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let Some(config) = GovernorConfigBuilder::default()
        .key_extractor(extractor)
        .per_second(replenish_secs.max(1))
        .burst_size(burst.max(1))
        .finish()
    else {
        // Unreachable with the clamps above; fail open rather than take auth down.
        tracing::error!("invalid auth rate limit config; limiter not installed");
        return routes;
    };

    let limiter = config.limiter().clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(CLEANUP_INTERVAL);
        loop {
            tick.tick().await;
            limiter.retain_recent();
        }
    });

    routes.layer(GovernorLayer::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(lines: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for l in lines {
            h.append("x-forwarded-for", HeaderValue::from_str(l).unwrap());
        }
        h
    }

    #[test]
    fn takes_the_last_hop_not_the_spoofable_first() {
        let h = headers(&["6.6.6.6, 203.0.113.9"]);
        assert_eq!(last_forwarded_for(&h), Some("203.0.113.9".parse().unwrap()));
    }

    #[test]
    fn last_hop_across_multiple_header_lines() {
        let h = headers(&["6.6.6.6", "198.51.100.4, 203.0.113.9"]);
        assert_eq!(last_forwarded_for(&h), Some("203.0.113.9".parse().unwrap()));
    }

    #[test]
    fn ignores_garbage_entries_and_handles_absence() {
        assert_eq!(
            last_forwarded_for(&headers(&["unknown, 203.0.113.9, junk"])),
            Some("203.0.113.9".parse().unwrap())
        );
        assert_eq!(last_forwarded_for(&HeaderMap::new()), None);
        assert_eq!(last_forwarded_for(&headers(&["not-an-ip"])), None);
    }

    #[test]
    fn falls_back_to_peer_when_forwarded_untrusted_or_missing() {
        let peer: SocketAddr = "192.0.2.7:5555".parse().unwrap();
        let build = |xff: Option<&str>| {
            let mut req = Request::new(());
            if let Some(v) = xff {
                req.headers_mut()
                    .insert("x-forwarded-for", HeaderValue::from_str(v).unwrap());
            }
            req.extensions_mut().insert(ConnectInfo(peer));
            req
        };

        let trusting = ClientIpKeyExtractor {
            trust_forwarded: true,
        };
        let direct = ClientIpKeyExtractor {
            trust_forwarded: false,
        };

        assert_eq!(
            trusting.extract(&build(Some("1.1.1.1, 2.2.2.2"))).unwrap(),
            "2.2.2.2".parse::<IpAddr>().unwrap()
        );
        assert_eq!(trusting.extract(&build(None)).unwrap(), peer.ip());
        assert_eq!(direct.extract(&build(Some("1.1.1.1"))).unwrap(), peer.ip());
    }

    // ── End to end through a real router ─────────────────────────────────────

    use axum::{body::Body, http::StatusCode, routing::post};
    use tower::ServiceExt;

    fn app(trust_forwarded: bool) -> Router {
        // 2 requests back to back, then one more per hour — so within a test the
        // bucket only ever drains.
        limit_with(
            Router::new().route("/login", post(|| async { "ok" })),
            2,
            3600,
            ClientIpKeyExtractor { trust_forwarded },
        )
    }

    async fn hit(app: &Router, peer: &str, xff: Option<&str>) -> StatusCode {
        let mut req = Request::builder().method("POST").uri("/login");
        if let Some(v) = xff {
            req = req.header("x-forwarded-for", v);
        }
        let mut req = req.body(Body::empty()).unwrap();
        let peer: SocketAddr = peer.parse().unwrap();
        req.extensions_mut().insert(ConnectInfo(peer));
        app.clone().oneshot(req).await.unwrap().status()
    }

    #[tokio::test]
    async fn blocks_after_burst_and_isolates_clients() {
        let app = app(true);
        let proxy = "10.0.0.1:1000"; // every request arrives from the proxy

        assert_eq!(hit(&app, proxy, Some("203.0.113.1")).await, StatusCode::OK);
        assert_eq!(hit(&app, proxy, Some("203.0.113.1")).await, StatusCode::OK);
        assert_eq!(
            hit(&app, proxy, Some("203.0.113.1")).await,
            StatusCode::TOO_MANY_REQUESTS
        );

        // A different real client (same proxy peer) has its own bucket.
        assert_eq!(hit(&app, proxy, Some("203.0.113.2")).await, StatusCode::OK);
    }

    #[tokio::test]
    async fn rotating_a_fake_leftmost_forwarded_entry_does_not_evade_the_limit() {
        let app = app(true);
        let proxy = "10.0.0.1:1000";
        // Attacker prepends a different fake IP each time; the proxy appends the
        // true one (203.0.113.9), which is what we key on.
        assert_eq!(
            hit(&app, proxy, Some("1.1.1.1, 203.0.113.9")).await,
            StatusCode::OK
        );
        assert_eq!(
            hit(&app, proxy, Some("2.2.2.2, 203.0.113.9")).await,
            StatusCode::OK
        );
        assert_eq!(
            hit(&app, proxy, Some("3.3.3.3, 203.0.113.9")).await,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn direct_mode_keys_on_the_socket_peer_and_ignores_the_header() {
        let app = app(false);
        // Same peer, header rotated every time -> still one bucket.
        assert_eq!(
            hit(&app, "192.0.2.7:1", Some("1.1.1.1")).await,
            StatusCode::OK
        );
        assert_eq!(
            hit(&app, "192.0.2.7:2", Some("2.2.2.2")).await,
            StatusCode::OK
        );
        assert_eq!(
            hit(&app, "192.0.2.7:3", Some("3.3.3.3")).await,
            StatusCode::TOO_MANY_REQUESTS
        );
        // Different peer -> fresh bucket.
        assert_eq!(hit(&app, "192.0.2.8:1", None).await, StatusCode::OK);
    }
}
