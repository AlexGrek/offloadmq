//! Browser cache policy (`Cache-Control`) for every response.
//!
//! | Path | Policy | Why |
//! |------|--------|-----|
//! | `/assets/*` (2xx/304) | `public, max-age=31536000, immutable` | Vite content-hashes the filenames |
//! | `/assets/*` (anything else) | `no-store` | a missing chunk must not stay "missing" after a deploy |
//! | `/api/*` | `no-store` unless the handler set its own | per-user, live JSON |
//! | everything else | `no-cache` | `index.html` (+ `favicon.png`) must revalidate so a deploy is picked up at once |
//!
//! Blob endpoints whose bytes never change for a given URL (image files,
//! thumbnails, audio, documents, prompt previews) opt in to [`IMMUTABLE_PRIVATE`]
//! themselves; the `/api` default only fills in when no header is present, so
//! their error responses still end up `no-store`.

use axum::{
    extract::Request,
    http::{HeaderValue, StatusCode, header::CACHE_CONTROL},
    middleware::Next,
    response::Response,
};

/// For per-user blobs addressed by an id whose content is written once.
/// `private` keeps them out of shared caches (the URL carries `?token=`).
pub const IMMUTABLE_PRIVATE: HeaderValue =
    HeaderValue::from_static("private, max-age=31536000, immutable");

const IMMUTABLE_PUBLIC: HeaderValue =
    HeaderValue::from_static("public, max-age=31536000, immutable");
const NO_STORE: HeaderValue = HeaderValue::from_static("no-store");
const NO_CACHE: HeaderValue = HeaderValue::from_static("no-cache");

pub async fn cache_control(req: Request, next: Next) -> Response {
    let policy = policy_for(req.uri().path());
    let mut res = next.run(req).await;
    let value = match policy {
        Policy::HashedAsset if is_cacheable(res.status()) => IMMUTABLE_PUBLIC,
        Policy::HashedAsset | Policy::Api => NO_STORE,
        Policy::Revalidate => NO_CACHE,
    };
    res.headers_mut().entry(CACHE_CONTROL).or_insert(value);
    res
}

#[derive(Debug, PartialEq)]
enum Policy {
    HashedAsset,
    Api,
    Revalidate,
}

fn policy_for(path: &str) -> Policy {
    if path.starts_with("/assets/") {
        Policy::HashedAsset
    } else if path == "/api" || path.starts_with("/api/") {
        Policy::Api
    } else {
        Policy::Revalidate
    }
}

fn is_cacheable(status: StatusCode) -> bool {
    status.is_success() || status == StatusCode::NOT_MODIFIED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_paths() {
        assert_eq!(policy_for("/assets/index-abc123.js"), Policy::HashedAsset);
        assert_eq!(policy_for("/api/me"), Policy::Api);
        assert_eq!(policy_for("/api"), Policy::Api);
        assert_eq!(policy_for("/"), Policy::Revalidate);
        assert_eq!(policy_for("/app/images"), Policy::Revalidate);
        assert_eq!(policy_for("/favicon.png"), Policy::Revalidate);
        assert_eq!(policy_for("/apiary"), Policy::Revalidate);
    }

    #[test]
    fn only_success_and_not_modified_assets_are_cacheable() {
        assert!(is_cacheable(StatusCode::OK));
        assert!(is_cacheable(StatusCode::PARTIAL_CONTENT));
        assert!(is_cacheable(StatusCode::NOT_MODIFIED));
        assert!(!is_cacheable(StatusCode::NOT_FOUND));
    }
}
