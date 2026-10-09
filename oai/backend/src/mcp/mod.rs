//! Remote MCP server (`POST /mcp`, Streamable HTTP) exposing OAI image generation to
//! MCP clients — chiefly Claude (web, desktop, mobile via a custom connector, and
//! Claude Code). Tools mirror the `oai image …` CLI commands and call the same service
//! layer as the REST routes. Authentication: OAuth (`services::oauth`) via
//! [`auth::mcp_auth_middleware`]. See `docs/mcp.md`.
//!
//! The server is stateless (no `Mcp-Session-Id`, no server-push GET stream) and
//! dual-era: legacy clients open with `initialize` (protocol 2024-11-05 … 2025-11-25);
//! modern clients (2026-07-28) carry the protocol version in each request's `_meta`
//! and may call `server/discover`. Every request is answered with a single JSON body.

pub mod auth;
pub mod content;
pub mod files;
pub mod tools;

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde_json::{Value, json};

use crate::{middleware::AuthenticatedUser, services::oauth, state::AppState, version};

/// Per-call context handed to every tool.
pub struct ToolContext {
    pub state: Arc<AppState>,
    pub user_id: i64,
    /// Public base URL, for building signed links.
    pub base: String,
}

/// Protocol revisions this server speaks, newest first.
pub const SUPPORTED_VERSIONS: &[&str] = &[
    "2026-07-28",
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
];
/// The per-request-metadata ("modern") revision.
const MODERN_VERSION: &str = "2026-07-28";
/// Offered to `initialize` callers whose requested revision we don't know.
const LATEST_LEGACY_VERSION: &str = "2025-11-25";
const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const HEADER_MISMATCH: i64 = -32020;
const UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;

/// How long clients may cache `tools/list` / `server/discover` (modern revision).
const LIST_TTL_MS: u64 = 5 * 60 * 1000;

const INSTRUCTIONS: &str = "OAI generates images on GPU workers. Typical flow: call \
generate_images with a prompt (the model is picked automatically unless you pass one from \
list_image_models). It waits for the result and returns preview thumbnails plus links to the \
full-resolution files. If a job is still running when the wait ends, call get_image_job with \
its job_id (optionally with wait_seconds) instead of submitting again. Prompts may contain \
placeholders: {color} {animal} {adjective} {country} {language} {name} {starwars}, the user's \
custom placeholders (list_placeholders, edit with save_placeholder), and {?} for a random \
two-word name. Keep placeholders in the prompt as written — the server substitutes them per \
job, exactly like the web UI; preview with expand_prompt. Saved prompts \
(list_saved_prompts) often contain placeholders and can be passed to generate_images as-is. \
To regenerate a job with new random values, use its prompt_template; retry_image_job \
repeats the exact same prompt.";

fn server_info() -> Value {
    json!({ "name": "oai-images", "title": "OAI image generation", "version": version::build_version() })
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message.into() });
    if let Some(d) = data {
        error["data"] = d;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn json_response(status: StatusCode, body: Value) -> Response {
    let mut resp = (status, axum::Json(body)).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

/// `Origin` allow-list (DNS-rebinding protection, required by the transport spec).
/// Server-to-server clients (Claude's connector backend) send no `Origin` at all.
fn origin_allowed(origin: &str, base: &str) -> bool {
    if origin == base || origin == "https://claude.ai" || origin == "https://claude.com" {
        return true;
    }
    if let Ok(url) = reqwest::Url::parse(origin)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return true;
    }
    crate::app::configured_cors_origins()
        .iter()
        .any(|o| o == origin)
}

/// `GET`/`DELETE /mcp`: no server-push stream and no sessions in this server.
pub async fn method_not_allowed() -> Response {
    let mut resp = StatusCode::METHOD_NOT_ALLOWED.into_response();
    resp.headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static("POST"));
    resp
}

/// `POST /mcp` — one JSON-RPC message (or a legacy batch array) per request.
pub async fn post_mcp(
    State(state): State<Arc<AppState>>,
    AuthenticatedUser(user_id): AuthenticatedUser,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let base = oauth::public_base_url(&headers);
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && !origin_allowed(origin, &base)
    {
        return json_response(
            StatusCode::FORBIDDEN,
            rpc_error(Value::Null, INVALID_REQUEST, "origin not allowed", None),
        );
    }
    let message: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                rpc_error(Value::Null, PARSE_ERROR, format!("parse error: {e}"), None),
            );
        }
    };
    let ctx = ToolContext {
        state,
        user_id,
        base,
    };

    if let Value::Array(batch) = message {
        // JSON-RPC batches (2025-03-26 only); answered as one array, always 200.
        let mut responses = Vec::new();
        for msg in batch {
            if let Some((_, resp)) = handle_message(&ctx, &headers, msg).await {
                responses.push(resp);
            }
        }
        return if responses.is_empty() {
            StatusCode::ACCEPTED.into_response()
        } else {
            json_response(StatusCode::OK, Value::Array(responses))
        };
    }

    match handle_message(&ctx, &headers, message).await {
        Some((status, resp)) => json_response(status, resp),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// Decodes the transport's `=?base64?…?=` header sentinel.
fn decode_header_value(raw: &str) -> String {
    raw.strip_prefix("=?base64?")
        .and_then(|r| r.strip_suffix("?="))
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| raw.to_string())
}

/// Handles one JSON-RPC message. `None` means "no response body" (a notification or
/// a client response), which the transport answers with 202.
async fn handle_message(
    ctx: &ToolContext,
    headers: &HeaderMap,
    msg: Value,
) -> Option<(StatusCode, Value)> {
    let method = msg.get("method").and_then(Value::as_str)?.to_string();
    let Some(id) = msg.get("id").cloned() else {
        // Notifications (`notifications/initialized`, `notifications/cancelled`, …)
        // need no action from a stateless server.
        return None;
    };
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };

    let meta_version = params
        .get("_meta")
        .and_then(|m| m.get(META_PROTOCOL_VERSION))
        .and_then(Value::as_str)
        .map(str::to_string);
    let header_version = header("mcp-protocol-version");
    let modern = meta_version.is_some();

    let unsupported = |requested: &str| {
        Some((
            StatusCode::BAD_REQUEST,
            rpc_error(
                id.clone(),
                UNSUPPORTED_PROTOCOL_VERSION,
                "Unsupported protocol version",
                Some(json!({ "supported": SUPPORTED_VERSIONS, "requested": requested })),
            ),
        ))
    };
    let mismatch = |what: String| {
        Some((
            StatusCode::BAD_REQUEST,
            rpc_error(id.clone(), HEADER_MISMATCH, what, None),
        ))
    };

    if let Some(v) = meta_version.as_deref() {
        if v != MODERN_VERSION {
            return unsupported(v);
        }
        if let Some(h) = header_version.as_deref()
            && h != v
        {
            return mismatch(format!(
                "Header mismatch: MCP-Protocol-Version '{h}' does not match _meta '{v}'"
            ));
        }
        if let Some(h) = header("mcp-method")
            && h != method
        {
            return mismatch(format!(
                "Header mismatch: Mcp-Method '{h}' does not match body '{method}'"
            ));
        }
        if let Some(h) = header("mcp-name").map(|h| decode_header_value(&h)) {
            let body_name = params
                .get("name")
                .or_else(|| params.get("uri"))
                .and_then(Value::as_str);
            if body_name != Some(h.as_str()) {
                return mismatch(format!(
                    "Header mismatch: Mcp-Name '{h}' does not match the request body"
                ));
            }
        }
    } else if method != "initialize"
        && let Some(h) = header_version.as_deref()
        && !SUPPORTED_VERSIONS.contains(&h)
    {
        return unsupported(h);
    }

    let result = match method.as_str() {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let version = if SUPPORTED_VERSIONS.contains(&requested) && requested != MODERN_VERSION
            {
                requested
            } else {
                LATEST_LEGACY_VERSION
            };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": server_info(),
                "instructions": INSTRUCTIONS,
            }))
        }
        "server/discover" => Ok(json!({
            "supportedVersions": SUPPORTED_VERSIONS,
            "capabilities": { "tools": {} },
            "instructions": INSTRUCTIONS,
            "ttlMs": LIST_TTL_MS,
            "cacheScope": "public",
        })),
        "ping" | "logging/setLevel" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": tools::definitions(),
            "ttlMs": LIST_TTL_MS,
            "cacheScope": "public",
        })),
        // Not advertised, but some clients probe them regardless.
        "resources/list" => Ok(json!({ "resources": [] })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match tools::call(ctx, name, args).await {
                Some(output) => Ok(output.into_value()),
                None => Err((
                    StatusCode::OK,
                    INVALID_PARAMS,
                    format!("Unknown tool: {name}"),
                )),
            }
        }
        other => Err((
            // Modern revisions distinguish "method not found" at the HTTP layer.
            if modern {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::OK
            },
            METHOD_NOT_FOUND,
            format!("Method not found: {other}"),
        )),
    };

    Some(match result {
        Ok(mut value) => {
            value["resultType"] = json!("complete");
            if modern {
                value["_meta"] = json!({ META_SERVER_INFO: server_info() });
            }
            (StatusCode::OK, rpc_result(id, value))
        }
        Err((status, code, message)) => (status, rpc_error(id, code, message, None)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ToolContext {
        let state = AppState {
            db: sea_orm::DatabaseConnection::Disconnected,
            auth: crate::middleware::auth::Auth::new(b"test-secret", 1),
            snowflake: crate::snowflake::SnowflakeGenerator::new(1),
            storage: None,
            http: reqwest::Client::new(),
            watch: crate::offload::watch::TaskWatch::for_test(),
        };
        ToolContext {
            state: Arc::new(state),
            user_id: 1,
            base: "https://oai.example".into(),
        }
    }

    async fn call(headers: &[(&'static str, &str)], msg: Value) -> Option<(StatusCode, Value)> {
        let mut h = HeaderMap::new();
        for (k, v) in headers {
            h.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        handle_message(&ctx(), &h, msg).await
    }

    fn modern_meta() -> Value {
        json!({ META_PROTOCOL_VERSION: MODERN_VERSION })
    }

    #[tokio::test]
    async fn initialize_negotiates_a_legacy_version() {
        let (status, resp) = call(&[], json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } },
        })).await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
        assert_eq!(resp["result"]["serverInfo"]["name"], "oai-images");

        let (_, resp) = call(&[], json!({
            "jsonrpc": "2.0", "id": "x", "method": "initialize", "params": { "protocolVersion": "1999-01-01" },
        })).await.unwrap();
        assert_eq!(resp["result"]["protocolVersion"], LATEST_LEGACY_VERSION);
    }

    #[tokio::test]
    async fn notifications_and_responses_get_no_body() {
        assert!(
            call(
                &[],
                json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
            )
            .await
            .is_none()
        );
        assert!(
            call(&[], json!({ "jsonrpc": "2.0", "id": 3, "result": {} }))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn tools_list_and_ping() {
        let (_, resp) = call(
            &[],
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .await
        .unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "generate_images"));
        assert_eq!(resp["result"]["resultType"], "complete");
        let (_, resp) = call(&[], json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }))
            .await
            .unwrap();
        assert!(resp["result"].is_object());
    }

    #[tokio::test]
    async fn unknown_methods_and_tools() {
        let (status, resp) = call(&[], json!({ "jsonrpc": "2.0", "id": 4, "method": "nope" }))
            .await
            .unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(resp["error"]["code"], METHOD_NOT_FOUND);

        let (status, resp) = call(
            &[],
            json!({
                "jsonrpc": "2.0", "id": 5, "method": "nope", "params": { "_meta": modern_meta() },
            }),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::NOT_FOUND, "modern revisions answer 404");
        assert_eq!(resp["error"]["code"], METHOD_NOT_FOUND);

        let (_, resp) = call(&[], json!({
            "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "nope", "arguments": {} },
        })).await.unwrap();
        assert_eq!(resp["error"]["code"], INVALID_PARAMS);
    }

    #[tokio::test]
    async fn modern_requests_are_validated() {
        let (status, resp) = call(
            &[],
            json!({
                "jsonrpc": "2.0", "id": 7, "method": "tools/list",
                "params": { "_meta": { META_PROTOCOL_VERSION: "2099-01-01" } },
            }),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(resp["error"]["code"], UNSUPPORTED_PROTOCOL_VERSION);
        assert_eq!(resp["error"]["data"]["requested"], "2099-01-01");

        let (status, resp) = call(&[("mcp-protocol-version", "2025-06-18")], json!({
            "jsonrpc": "2.0", "id": 8, "method": "tools/list", "params": { "_meta": modern_meta() },
        })).await.unwrap();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(resp["error"]["code"], HEADER_MISMATCH);

        let (status, resp) = call(&[("mcp-method", "tools/call")], json!({
            "jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": { "_meta": modern_meta() },
        })).await.unwrap();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(resp["error"]["code"], HEADER_MISMATCH);

        let (status, resp) = call(
            &[("mcp-protocol-version", MODERN_VERSION), ("mcp-method", "server/discover")],
            json!({ "jsonrpc": "2.0", "id": 10, "method": "server/discover", "params": { "_meta": modern_meta() } }),
        ).await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(resp["result"]["supportedVersions"][0], MODERN_VERSION);
        assert_eq!(
            resp["result"]["_meta"][META_SERVER_INFO]["name"],
            "oai-images"
        );
        assert_eq!(resp["result"]["resultType"], "complete");
    }

    #[tokio::test]
    async fn legacy_header_with_unknown_version_is_rejected() {
        let (status, resp) = call(
            &[("mcp-protocol-version", "2099-01-01")],
            json!({
                "jsonrpc": "2.0", "id": 11, "method": "tools/list",
            }),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(resp["error"]["code"], UNSUPPORTED_PROTOCOL_VERSION);
    }

    #[test]
    fn header_sentinel_decoding() {
        assert_eq!(decode_header_value("generate_images"), "generate_images");
        assert_eq!(
            decode_header_value("=?base64?SGVsbG8sIOS4lueVjA==?="),
            "Hello, 世界"
        );
        assert_eq!(decode_header_value("=?base64?!!!?="), "=?base64?!!!?=");
    }

    #[test]
    fn origins() {
        let base = "https://oai.alexgr.space";
        assert!(origin_allowed("https://oai.alexgr.space", base));
        assert!(origin_allowed("https://claude.ai", base));
        assert!(origin_allowed("http://localhost:6274", base));
        assert!(!origin_allowed("https://evil.example", base));
        assert!(!origin_allowed("http://evil.example", base));
    }
}
