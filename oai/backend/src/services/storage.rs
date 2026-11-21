//! Thin helpers over the OpenDAL operator held in `AppState`.
//! Centralizes the "is storage enabled?" check so handlers never touch
//! `state.storage` directly or unwrap it.

use opendal::Operator;

use crate::{error::AppError, state::AppState};

/// Returns the configured storage operator, or a `BadRequest` if the backend
/// is disabled. Replaces the previous `ensure_storage_enabled` + `.expect()`
/// pattern with a single fallible accessor.
pub fn operator(state: &AppState) -> Result<&Operator, AppError> {
    state.storage.as_ref().ok_or_else(|| {
        AppError::BadRequest(
            "storage backend is disabled; set STORAGE_BACKEND=fs (or local) for dev, s3 for prod"
                .into(),
        )
    })
}

pub async fn read(op: &Operator, path: &str) -> Result<Vec<u8>, AppError> {
    op.read(path)
        .await
        .map(|b| b.to_vec())
        .map_err(|e| AppError::Internal(format!("storage read failed: {e}")))
}

pub async fn write(op: &Operator, path: &str, bytes: Vec<u8>) -> Result<(), AppError> {
    op.write(path, bytes)
        .await
        .map(|_| ())
        .map_err(|e| AppError::Internal(format!("storage write failed: {e}")))
}

/// Returns whether a blob exists at `path`.
pub async fn exists(op: &Operator, path: &str) -> Result<bool, AppError> {
    op.exists(path)
        .await
        .map_err(|e| AppError::Internal(format!("storage exists check failed: {e}")))
}

/// Lists object paths beneath a prefix. Used by the media library to resolve a
/// user's starred-image set without issuing one storage request per file.
pub async fn list(op: &Operator, path: &str) -> Result<Vec<String>, AppError> {
    op.list(path)
        .await
        .map(|entries| entries.into_iter().map(|entry| entry.path().to_owned()).collect())
        .map_err(|e| AppError::Internal(format!("storage list failed: {e}")))
}

/// Outcome of parsing a `Range` request header against a blob of `len` bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum ByteRange {
    /// No (or an unsupported multi-range / malformed) header: send everything.
    Full,
    /// Inclusive `start..=end`, already clamped to the blob.
    Partial(u64, u64),
    /// Syntactically valid but outside the blob → 416.
    Unsatisfiable,
}

/// Single-range `bytes=a-b` / `bytes=a-` / `bytes=-n` parsing (RFC 9110 §14.1.2).
/// Multi-range requests fall back to the full body, which RFC 9110 permits.
pub fn parse_range(header: Option<&str>, len: u64) -> ByteRange {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return ByteRange::Full;
    };
    if spec.contains(',') {
        return ByteRange::Full;
    }
    let Some((a, b)) = spec.trim().split_once('-') else {
        return ByteRange::Full;
    };
    let (a, b) = (a.trim(), b.trim());
    let range = match (a.parse::<u64>().ok(), b.parse::<u64>().ok()) {
        (Some(start), Some(end)) if start <= end => Some((start, end.min(len.saturating_sub(1)))),
        (Some(start), None) if b.is_empty() => Some((start, len.saturating_sub(1))),
        (None, Some(suffix)) if a.is_empty() && suffix > 0 => Some((len.saturating_sub(suffix), len.saturating_sub(1))),
        _ => return ByteRange::Full,
    };
    match range {
        Some((start, end)) if len > 0 && start < len => ByteRange::Partial(start, end),
        _ => ByteRange::Unsatisfiable,
    }
}

/// Streams a blob as an HTTP response without buffering it in memory, honouring
/// a single `Range` request (206 / 416) so large downloads — VR Worlds PLYs run to
/// hundreds of MiB — can resume. Callers add their own cache/disposition headers.
pub async fn stream_file(
    op: &Operator,
    path: &str,
    content_type: &str,
    range_header: Option<&str>,
) -> Result<axum::response::Response, AppError> {
    use axum::{
        body::Body,
        http::{HeaderValue, StatusCode, header},
        response::IntoResponse,
    };

    let meta = op.stat(path).await.map_err(|e| match e.kind() {
        opendal::ErrorKind::NotFound => AppError::NotFound,
        _ => AppError::Internal(format!("storage stat failed: {e}")),
    })?;
    let len = meta.content_length();
    let (status, start, end) = match parse_range(range_header, len) {
        ByteRange::Full => (StatusCode::OK, 0, len),
        ByteRange::Partial(s, e) => (StatusCode::PARTIAL_CONTENT, s, e + 1),
        ByteRange::Unsatisfiable => {
            let mut resp = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            if let Ok(v) = HeaderValue::from_str(&format!("bytes */{len}")) {
                resp.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            return Ok(resp);
        }
    };
    let stream = op
        .reader(path)
        .await
        .map_err(|e| AppError::Internal(format!("storage open failed: {e}")))?
        .into_bytes_stream(start..end)
        .await
        .map_err(|e| AppError::Internal(format!("storage stream failed: {e}")))?;

    let mut resp = (status, Body::from_stream(stream)).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(end - start));
    if status == StatusCode::PARTIAL_CONTENT
        && let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{}/{len}", end - 1))
    {
        h.insert(header::CONTENT_RANGE, v);
    }
    Ok(resp)
}

/// Deletes a blob if present; missing paths are ignored.
pub async fn delete(op: &Operator, path: &str) -> Result<(), AppError> {
    match op.delete(path).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == opendal::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Internal(format!("storage delete failed: {e}"))),
    }
}

#[cfg(test)]
mod range_tests {
    use super::{ByteRange::*, parse_range};

    #[tokio::test]
    async fn streams_requested_bytes_and_reports_unsatisfiable_ranges() {
        use axum::{body::to_bytes, http::StatusCode};
        let root = std::env::temp_dir().join(format!("oai-world-stream-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        let builder = opendal::services::Fs::default().root(root.to_str().unwrap());
        let op = opendal::Operator::new(builder).unwrap().finish();
        op.write("scene.ply", "ply\n0123456789").await.unwrap();
        let response = super::stream_file(&op, "scene.ply", "application/octet-stream", Some("bytes=0-3")).await.unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 0-3/14");
        assert_eq!(response.headers()["content-length"], "4");
        assert_eq!(to_bytes(response.into_body(), 100).await.unwrap().as_ref(), b"ply\n");
        let response = super::stream_file(&op, "scene.ply", "application/octet-stream", Some("bytes=14-")).await.unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()["content-range"], "bytes */14");
        op.delete("scene.ply").await.unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn parses_single_ranges() {
        assert_eq!(parse_range(None, 100), Full);
        assert_eq!(parse_range(Some("bytes=0-99"), 100), Partial(0, 99));
        assert_eq!(parse_range(Some("bytes=10-"), 100), Partial(10, 99));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Partial(90, 99));
        assert_eq!(parse_range(Some("bytes=50-500"), 100), Partial(50, 99));
        assert_eq!(parse_range(Some("bytes=-500"), 100), Partial(0, 99));
    }

    #[test]
    fn rejects_or_ignores_the_rest() {
        assert_eq!(parse_range(Some("bytes=100-"), 100), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-1"), 0), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), Full);
        assert_eq!(parse_range(Some("items=0-1"), 100), Full);
        assert_eq!(parse_range(Some("bytes=9-3"), 100), Full);
        assert_eq!(parse_range(Some("bytes=abc"), 100), Full);
    }
}
