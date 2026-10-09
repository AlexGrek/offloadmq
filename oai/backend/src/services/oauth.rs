//! OAuth 2.1 authorization server for the MCP endpoint (`/mcp`).
//!
//! What Claude's connector client (claude.ai web, desktop, mobile, Claude Code) needs,
//! and nothing more: Dynamic Client Registration (RFC 7591) for public clients, the
//! authorization-code grant with mandatory S256 PKCE, rotating refresh tokens, RFC 9728
//! protected-resource and RFC 8414 authorization-server metadata, and RFC 7009
//! revocation. Users authenticate with their OAI login/password on a server-rendered
//! consent page (`routes::oauth`). Tokens are opaque random strings; only their SHA-256
//! is stored (`db::oauth`). See `docs/mcp.md`.

use std::sync::OnceLock;

use axum::{
    Json,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    db::oauth::{self, KIND_ACCESS, KIND_REFRESH},
    error::{AppError, ResultExt},
    services::image_processing::sha256_hex,
    state::AppState,
};

/// The only scope this server issues. Requested scopes are otherwise ignored.
pub const SCOPE: &str = "mcp";
/// Path of the MCP endpoint relative to the public base URL.
pub const MCP_PATH: &str = "/mcp";

const CODE_TTL: chrono::Duration = chrono::Duration::minutes(5);
const ACCESS_TOKEN_TTL: chrono::Duration = chrono::Duration::hours(1);
/// Sliding: every refresh issues a new refresh token valid for this long.
const REFRESH_TOKEN_TTL: chrono::Duration = chrono::Duration::days(30);
/// A rotated-out refresh token presented again within this window is answered with
/// `invalid_grant` but does not revoke the grant — it is most likely a client retrying
/// a refresh whose response it never received, or two refreshes racing. Later reuse is
/// treated as token theft and kills the whole grant (OAuth 2.1 §4.3.1).
const REFRESH_REUSE_GRACE: chrono::Duration = chrono::Duration::minutes(2);
/// `oauth_grants.last_used_at` is refreshed at most this often.
const GRANT_TOUCH_INTERVAL: chrono::Duration = chrono::Duration::minutes(5);

const MAX_REDIRECT_URIS: usize = 10;
const MAX_REDIRECT_URI_LEN: usize = 2_000;
const MAX_CLIENT_NAME_LEN: usize = 200;

// ── Base URL / resource identifiers ──────────────────────────────────────────

fn configured_base_url() -> Option<&'static str> {
    static BASE: OnceLock<Option<String>> = OnceLock::new();
    BASE.get_or_init(|| {
        std::env::var("PUBLIC_BASE_URL")
            .ok()
            .map(|v| v.trim().trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty())
    })
    .as_deref()
}

fn first_header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// Public origin of this server (`https://oai.alexgr.space`), used as the OAuth issuer
/// and to build the MCP resource URL. `PUBLIC_BASE_URL` wins; without it the origin is
/// rebuilt from the proxy headers (`X-Forwarded-Proto`/`-Host`) or `Host`.
pub fn public_base_url(headers: &HeaderMap) -> String {
    if let Some(base) = configured_base_url() {
        return base.to_string();
    }
    let proto = first_header_value(headers, "x-forwarded-proto").unwrap_or("http");
    let host = first_header_value(headers, "x-forwarded-host")
        .or_else(|| first_header_value(headers, "host"))
        .unwrap_or("localhost");
    format!("{proto}://{host}")
}

pub fn mcp_resource(base: &str) -> String {
    format!("{base}{MCP_PATH}")
}

pub fn resource_metadata_url(base: &str) -> String {
    format!("{base}/.well-known/oauth-protected-resource{MCP_PATH}")
}

/// `resource` (RFC 8707) must name this server's MCP endpoint. The bare origin and a
/// trailing slash are tolerated — clients differ in how they canonicalize it.
pub fn resource_matches(base: &str, resource: &str) -> bool {
    let r = resource.trim_end_matches('/');
    r == mcp_resource(base) || r == base
}

// ── Metadata documents ───────────────────────────────────────────────────────

pub fn protected_resource_metadata(base: &str) -> serde_json::Value {
    json!({
        "resource": mcp_resource(base),
        "authorization_servers": [base],
        "scopes_supported": [SCOPE],
        "bearer_methods_supported": ["header"],
        "resource_name": "OAI image generation",
        "resource_documentation": format!("{base}/"),
    })
}

pub fn authorization_server_metadata(base: &str) -> serde_json::Value {
    json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/oauth/authorize"),
        "token_endpoint": format!("{base}/oauth/token"),
        "registration_endpoint": format!("{base}/oauth/register"),
        "revocation_endpoint": format!("{base}/oauth/revoke"),
        "scopes_supported": [SCOPE],
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "revocation_endpoint_auth_methods_supported": ["none"],
        "authorization_response_iss_parameter_supported": true,
    })
}

// ── Primitives ───────────────────────────────────────────────────────────────

/// 256 bits of randomness, base64url without padding.
pub fn random_token() -> String {
    let bytes: [u8; 32] = rand::random();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> String {
    sha256_hex(token.as_bytes())
}

/// RFC 7636 S256: `BASE64URL(SHA256(ascii(code_verifier))) == code_challenge`.
pub fn pkce_s256_matches(verifier: &str, challenge: &str) -> bool {
    // RFC 7636 §4.1: 43–128 chars from the unreserved set.
    let valid_verifier = (43..=128).contains(&verifier.len())
        && verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'));
    if !valid_verifier {
        return false;
    }
    let digest = Sha256::digest(verifier.as_bytes());
    let computed = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    subtle::ConstantTimeEq::ct_eq(computed.as_bytes(), challenge.as_bytes()).into()
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// Registration-time check: `https`, or plain `http` on a loopback host (native clients
/// such as Claude Code, MCP Inspector). No fragments, no credentials in the URL.
pub fn validate_redirect_uri(uri: &str) -> Result<(), String> {
    if uri.len() > MAX_REDIRECT_URI_LEN {
        return Err("redirect_uri is too long".into());
    }
    let url = reqwest::Url::parse(uri).map_err(|_| format!("invalid redirect_uri: {uri}"))?;
    if url.fragment().is_some() {
        return Err("redirect_uri must not contain a fragment".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("redirect_uri must not contain credentials".into());
    }
    let host = url.host_str().unwrap_or_default();
    match url.scheme() {
        "https" if !host.is_empty() => Ok(()),
        "http" if is_loopback_host(host) => Ok(()),
        _ => Err(format!(
            "redirect_uri must be https, or http on localhost/127.0.0.1: {uri}"
        )),
    }
}

/// Whether `requested` is one of the client's registered redirect URIs: an exact string
/// match, or — for loopback `http` URIs only — a match that ignores the port, since
/// native clients bind an ephemeral port per session (RFC 8252 §7.3).
pub fn redirect_uri_allowed(registered: &[String], requested: &str) -> bool {
    if registered.iter().any(|r| r == requested) {
        return true;
    }
    let Ok(req) = reqwest::Url::parse(requested) else {
        return false;
    };
    if req.scheme() != "http" || !req.host_str().is_some_and(is_loopback_host) {
        return false;
    }
    registered.iter().any(|r| {
        reqwest::Url::parse(r).is_ok_and(|reg| {
            reg.scheme() == "http"
                && reg.host_str() == req.host_str()
                && reg.path() == req.path()
                && reg.query() == req.query()
        })
    })
}

// ── Errors (RFC 6749 §5.2 shape) ─────────────────────────────────────────────

/// An OAuth protocol error, rendered as `{ "error", "error_description" }` JSON.
#[derive(Debug)]
pub struct OAuthError {
    pub status: StatusCode,
    pub error: &'static str,
    pub description: String,
}

impl OAuthError {
    pub fn invalid_request(description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            error: "invalid_request",
            description: description.into(),
        }
    }
    pub fn invalid_grant(description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            error: "invalid_grant",
            description: description.into(),
        }
    }
    /// 401 — Claude re-registers via DCR when it sees this from the token endpoint.
    pub fn invalid_client(description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            error: "invalid_client",
            description: description.into(),
        }
    }
    pub fn unsupported_grant_type(grant_type: &str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            error: "unsupported_grant_type",
            description: format!("unsupported grant_type: {grant_type}"),
        }
    }
    pub fn invalid_redirect_uri(description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            error: "invalid_redirect_uri",
            description: description.into(),
        }
    }
    pub fn invalid_client_metadata(description: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            error: "invalid_client_metadata",
            description: description.into(),
        }
    }
    pub fn server_error(e: AppError) -> Self {
        tracing::error!("oauth server error: {e:?}");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            error: "server_error",
            description: "internal server error".into(),
        }
    }
}

impl From<AppError> for OAuthError {
    fn from(e: AppError) -> Self {
        Self::server_error(e)
    }
}

impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        let mut resp = (
            self.status,
            Json(json!({ "error": self.error, "error_description": self.description })),
        )
            .into_response();
        resp.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        resp
    }
}

// ── Dynamic Client Registration ──────────────────────────────────────────────

#[derive(Serialize)]
pub struct RegisteredClient {
    pub client_id: String,
    pub client_id_issued_at: i64,
    pub client_name: String,
    pub redirect_uris: Vec<String>,
    pub grant_types: Vec<&'static str>,
    pub response_types: Vec<&'static str>,
    pub token_endpoint_auth_method: &'static str,
    pub scope: &'static str,
}

pub async fn register_client(
    state: &AppState,
    client_name: Option<String>,
    redirect_uris: Vec<String>,
) -> Result<RegisteredClient, OAuthError> {
    if redirect_uris.is_empty() {
        return Err(OAuthError::invalid_redirect_uri(
            "at least one redirect_uri is required",
        ));
    }
    if redirect_uris.len() > MAX_REDIRECT_URIS {
        return Err(OAuthError::invalid_redirect_uri(format!(
            "at most {MAX_REDIRECT_URIS} redirect_uris are allowed"
        )));
    }
    for uri in &redirect_uris {
        validate_redirect_uri(uri).map_err(OAuthError::invalid_redirect_uri)?;
    }
    let client_name = client_name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "MCP client".to_string());
    if client_name.chars().count() > MAX_CLIENT_NAME_LEN {
        return Err(OAuthError::invalid_client_metadata(
            "client_name is too long",
        ));
    }

    let client_id = random_token();
    let client = oauth::create_client(&state.db, &client_id, &client_name, &redirect_uris).await?;
    Ok(RegisteredClient {
        client_id: client.client_id,
        client_id_issued_at: client.created_at.timestamp(),
        client_name: client.client_name,
        redirect_uris,
        grant_types: vec!["authorization_code", "refresh_token"],
        response_types: vec!["code"],
        token_endpoint_auth_method: "none",
        scope: SCOPE,
    })
}

// ── Authorization request ────────────────────────────────────────────────────

/// The authorization request parameters, as received on `GET /oauth/authorize` and
/// echoed back through the consent form's hidden fields.
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct AuthorizeParams {
    #[serde(default)]
    pub response_type: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub redirect_uri: Option<String>,
    #[serde(default)]
    pub code_challenge: Option<String>,
    #[serde(default)]
    pub code_challenge_method: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub resource: Option<String>,
}

/// A validated authorization request.
pub struct ValidAuthorize {
    pub client: oauth::Client,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub state: Option<String>,
    pub resource: Option<String>,
}

pub enum AuthorizeError {
    /// The client or redirect URI can't be trusted: show an error page, never redirect.
    Fatal(String),
    /// Report back to the (verified) redirect URI with `error=…`.
    Redirect {
        redirect_uri: String,
        state: Option<String>,
        error: &'static str,
        description: String,
    },
}

pub async fn validate_authorize(
    state: &AppState,
    base: &str,
    p: &AuthorizeParams,
) -> Result<ValidAuthorize, AuthorizeError> {
    let client_id = p
        .client_id
        .as_deref()
        .filter(|c| !c.is_empty())
        .ok_or_else(|| AuthorizeError::Fatal("Missing client_id.".into()))?;
    let client = oauth::find_client(&state.db, client_id)
        .await
        .map_err(|e| {
            tracing::error!("oauth client lookup failed: {e:?}");
            AuthorizeError::Fatal("Internal error. Please try again.".into())
        })?
        .ok_or_else(|| {
            AuthorizeError::Fatal(
                "Unknown client. Remove the connector and add it again to re-register.".into(),
            )
        })?;
    let registered = oauth::client_redirect_uris(&client);
    let redirect_uri = match p.redirect_uri.as_deref().filter(|r| !r.is_empty()) {
        Some(r) if redirect_uri_allowed(&registered, r) => r.to_string(),
        Some(_) => {
            return Err(AuthorizeError::Fatal(
                "The redirect_uri does not match the client's registration.".into(),
            ));
        }
        // OAuth 2.1 allows omitting it only when exactly one is registered.
        None if registered.len() == 1 => registered[0].clone(),
        None => return Err(AuthorizeError::Fatal("Missing redirect_uri.".into())),
    };

    let fail = |error: &'static str, description: &str| AuthorizeError::Redirect {
        redirect_uri: redirect_uri.clone(),
        state: p.state.clone(),
        error,
        description: description.to_string(),
    };
    if p.response_type.as_deref() != Some("code") {
        return Err(fail(
            "unsupported_response_type",
            "response_type must be code",
        ));
    }
    let code_challenge = p
        .code_challenge
        .as_deref()
        .filter(|c| (43..=128).contains(&c.len()))
        .ok_or_else(|| fail("invalid_request", "a PKCE code_challenge is required"))?;
    if p.code_challenge_method.as_deref() != Some("S256") {
        return Err(fail(
            "invalid_request",
            "code_challenge_method must be S256",
        ));
    }
    let resource = p.resource.as_deref().filter(|r| !r.is_empty());
    if let Some(r) = resource
        && !resource_matches(base, r)
    {
        return Err(fail(
            "invalid_target",
            "resource must be this server's /mcp endpoint",
        ));
    }

    Ok(ValidAuthorize {
        code_challenge: code_challenge.to_string(),
        state: p.state.clone(),
        resource: resource.map(str::to_string),
        redirect_uri,
        client,
    })
}

/// Appends query parameters to a redirect URI (keeping any it already has).
pub fn redirect_with(redirect_uri: &str, params: &[(&str, &str)]) -> String {
    match reqwest::Url::parse(redirect_uri) {
        Ok(mut url) => {
            {
                let mut q = url.query_pairs_mut();
                for (k, v) in params {
                    q.append_pair(k, v);
                }
            }
            url.to_string()
        }
        Err(_) => redirect_uri.to_string(),
    }
}

/// Issues a single-use authorization code for an approved request; returns the code.
pub async fn issue_code(
    state: &AppState,
    req: &ValidAuthorize,
    user_id: i64,
) -> Result<String, AppError> {
    let code = random_token();
    oauth::create_code(
        &state.db,
        oauth::NewAuthCode {
            code_hash: &hash_token(&code),
            client_id: &req.client.client_id,
            user_id,
            redirect_uri: &req.redirect_uri,
            code_challenge: &req.code_challenge,
            scope: SCOPE,
            resource: req.resource.as_deref(),
            expires_at: chrono::Utc::now().fixed_offset() + CODE_TTL,
        },
    )
    .await?;
    Ok(code)
}

// ── Token endpoint ───────────────────────────────────────────────────────────

/// `POST /oauth/token` form body (both grants).
#[derive(Debug, Default, serde::Deserialize)]
pub struct TokenRequest {
    #[serde(default)]
    pub grant_type: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub redirect_uri: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub code_verifier: Option<String>,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub resource: Option<String>,
}

#[derive(Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub refresh_token: String,
    pub scope: &'static str,
}

async fn issue_token_pair(
    state: &AppState,
    grant: &oauth::Grant,
) -> Result<TokenResponse, AppError> {
    let now = chrono::Utc::now().fixed_offset();
    let access = random_token();
    let refresh = random_token();
    oauth::insert_token(
        &state.db,
        &hash_token(&access),
        grant.id,
        grant.user_id,
        KIND_ACCESS,
        now + ACCESS_TOKEN_TTL,
    )
    .await?;
    oauth::insert_token(
        &state.db,
        &hash_token(&refresh),
        grant.id,
        grant.user_id,
        KIND_REFRESH,
        now + REFRESH_TOKEN_TTL,
    )
    .await?;
    Ok(TokenResponse {
        access_token: access,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL.num_seconds(),
        refresh_token: refresh,
        scope: SCOPE,
    })
}

fn required<'a>(v: &'a Option<String>, name: &str) -> Result<&'a str, OAuthError> {
    v.as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OAuthError::invalid_request(format!("{name} is required")))
}

async fn require_client(state: &AppState, client_id: &str) -> Result<oauth::Client, OAuthError> {
    oauth::find_client(&state.db, client_id)
        .await?
        .ok_or_else(|| OAuthError::invalid_client("unknown client_id"))
}

pub async fn token(
    state: &AppState,
    base: &str,
    req: TokenRequest,
) -> Result<TokenResponse, OAuthError> {
    match req.grant_type.as_deref().unwrap_or_default() {
        "authorization_code" => exchange_code(state, base, &req).await,
        "refresh_token" => refresh(state, &req).await,
        other => Err(OAuthError::unsupported_grant_type(other)),
    }
}

async fn exchange_code(
    state: &AppState,
    base: &str,
    req: &TokenRequest,
) -> Result<TokenResponse, OAuthError> {
    let client_id = required(&req.client_id, "client_id")?;
    let code = required(&req.code, "code")?;
    let verifier = required(&req.code_verifier, "code_verifier")?;
    let client = require_client(state, client_id).await?;

    let stored = oauth::consume_code(&state.db, &hash_token(code))
        .await?
        .ok_or_else(|| {
            OAuthError::invalid_grant("authorization code is invalid, expired or already used")
        })?;
    if stored.client_id != client.client_id {
        return Err(OAuthError::invalid_grant(
            "authorization code was issued to another client",
        ));
    }
    if let Some(redirect_uri) = req.redirect_uri.as_deref().filter(|r| !r.is_empty())
        && redirect_uri != stored.redirect_uri
    {
        return Err(OAuthError::invalid_grant(
            "redirect_uri does not match the authorization request",
        ));
    }
    if !pkce_s256_matches(verifier, &stored.code_challenge) {
        return Err(OAuthError::invalid_grant("PKCE verification failed"));
    }
    if let Some(resource) = req.resource.as_deref().filter(|r| !r.is_empty())
        && !resource_matches(base, resource)
    {
        return Err(OAuthError {
            error: "invalid_target",
            ..OAuthError::invalid_request("unknown resource")
        });
    }

    let grant = oauth::create_grant(
        &state.db,
        state.next_id(),
        stored.user_id,
        &client.client_id,
        &stored.scope,
    )
    .await?;
    tracing::info!(user_id = grant.user_id, grant_id = grant.id, client = %client.client_name, "oauth grant created");
    Ok(issue_token_pair(state, &grant).await?)
}

async fn refresh(state: &AppState, req: &TokenRequest) -> Result<TokenResponse, OAuthError> {
    let presented = required(&req.refresh_token, "refresh_token")?;
    let token_hash = hash_token(presented);
    let token = oauth::find_token(&state.db, &token_hash)
        .await?
        .filter(|t| t.kind == KIND_REFRESH)
        .ok_or_else(|| OAuthError::invalid_grant("refresh token is invalid"))?;
    let grant = oauth::find_grant(&state.db, token.grant_id)
        .await?
        .filter(|g| g.revoked_at.is_none())
        .ok_or_else(|| OAuthError::invalid_grant("the connection was revoked"))?;
    // Public clients send client_id; when they do it must be the grant's client.
    if let Some(client_id) = req.client_id.as_deref().filter(|c| !c.is_empty())
        && client_id != grant.client_id
    {
        return Err(OAuthError::invalid_grant(
            "refresh token was issued to another client",
        ));
    }

    let now = chrono::Utc::now().fixed_offset();
    if let Some(revoked_at) = token.revoked_at {
        if now - revoked_at > REFRESH_REUSE_GRACE {
            tracing::warn!(
                grant_id = grant.id,
                "rotated refresh token reused; revoking grant"
            );
            oauth::revoke_grant(&state.db, grant.id).await?;
        }
        return Err(OAuthError::invalid_grant("refresh token was already used"));
    }
    if token.expires_at <= now {
        return Err(OAuthError::invalid_grant("refresh token expired"));
    }
    if !oauth::revoke_token_if_active(&state.db, &token_hash).await? {
        return Err(OAuthError::invalid_grant("refresh token was already used"));
    }
    Ok(issue_token_pair(state, &grant).await?)
}

/// RFC 7009: revoking a refresh token ends the whole connection; revoking an access
/// token only that token. Unknown tokens are silently accepted, as the RFC requires.
pub async fn revoke(state: &AppState, token: &str) -> Result<(), AppError> {
    let token_hash = hash_token(token);
    let Some(row) = oauth::find_token(&state.db, &token_hash).await? else {
        return Ok(());
    };
    if row.kind == KIND_REFRESH {
        oauth::revoke_grant(&state.db, row.grant_id).await
    } else {
        oauth::revoke_token_if_active(&state.db, &token_hash)
            .await
            .map(|_| ())
    }
}

/// Resolves a bearer access token to its user, or `None` when it is unknown, expired,
/// revoked, or its grant was revoked.
pub async fn authenticate_access_token(
    state: &AppState,
    token: &str,
) -> Result<Option<i64>, AppError> {
    let Some(row) = oauth::find_token(&state.db, &hash_token(token)).await? else {
        return Ok(None);
    };
    let now = chrono::Utc::now().fixed_offset();
    if row.kind != KIND_ACCESS || row.revoked_at.is_some() || row.expires_at <= now {
        return Ok(None);
    }
    let Some(grant) = oauth::find_grant(&state.db, row.grant_id).await? else {
        return Ok(None);
    };
    if grant.revoked_at.is_some() {
        return Ok(None);
    }
    oauth::touch_grant(&state.db, grant.id, GRANT_TOUCH_INTERVAL)
        .await
        .log_warn("touch oauth grant");
    Ok(Some(row.user_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_rfc7636_appendix_b_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert!(pkce_s256_matches(verifier, challenge));
        assert!(!pkce_s256_matches(
            verifier,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cX"
        ));
        // Too short to be a valid verifier, even if it hashed right.
        assert!(!pkce_s256_matches("short", challenge));
    }

    #[test]
    fn registration_accepts_https_and_loopback_http_only() {
        assert!(validate_redirect_uri("https://claude.ai/api/mcp/auth_callback").is_ok());
        assert!(validate_redirect_uri("http://localhost:3118/callback").is_ok());
        assert!(validate_redirect_uri("http://127.0.0.1/callback").is_ok());
        assert!(validate_redirect_uri("http://example.com/callback").is_err());
        assert!(validate_redirect_uri("https://claude.ai/cb#frag").is_err());
        assert!(validate_redirect_uri("https://user:pw@claude.ai/cb").is_err());
        assert!(validate_redirect_uri("javascript:alert(1)").is_err());
        assert!(validate_redirect_uri("not a url").is_err());
    }

    #[test]
    fn redirect_matching_is_exact_except_loopback_port() {
        let reg = vec![
            "https://claude.ai/api/mcp/auth_callback".to_string(),
            "http://localhost/callback".to_string(),
            "http://127.0.0.1/callback".to_string(),
        ];
        assert!(redirect_uri_allowed(
            &reg,
            "https://claude.ai/api/mcp/auth_callback"
        ));
        assert!(!redirect_uri_allowed(
            &reg,
            "https://claude.ai/api/mcp/auth_callback2"
        ));
        assert!(!redirect_uri_allowed(
            &reg,
            "https://claude.ai:8443/api/mcp/auth_callback"
        ));
        assert!(redirect_uri_allowed(&reg, "http://localhost:3118/callback"));
        assert!(redirect_uri_allowed(
            &reg,
            "http://127.0.0.1:50000/callback"
        ));
        assert!(!redirect_uri_allowed(&reg, "http://localhost:3118/other"));
        assert!(!redirect_uri_allowed(&reg, "http://evil.com:3118/callback"));
        // localhost and 127.0.0.1 are distinct registrations.
        let only_localhost = vec!["http://localhost/callback".to_string()];
        assert!(!redirect_uri_allowed(
            &only_localhost,
            "http://127.0.0.1:1/callback"
        ));
    }

    #[test]
    fn resource_accepts_mcp_url_and_origin() {
        let base = "https://oai.alexgr.space";
        assert!(resource_matches(base, "https://oai.alexgr.space/mcp"));
        assert!(resource_matches(base, "https://oai.alexgr.space/mcp/"));
        assert!(resource_matches(base, "https://oai.alexgr.space"));
        assert!(!resource_matches(base, "https://evil.example/mcp"));
    }

    #[test]
    fn base_url_from_proxy_headers() {
        let mut h = HeaderMap::new();
        h.insert("host", HeaderValue::from_static("internal:3000"));
        h.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        h.insert(
            "x-forwarded-host",
            HeaderValue::from_static("oai.alexgr.space"),
        );
        if configured_base_url().is_none() {
            assert_eq!(public_base_url(&h), "https://oai.alexgr.space");
        }
    }

    #[test]
    fn redirect_with_keeps_existing_query() {
        let url = redirect_with(
            "https://a.example/cb?x=1",
            &[("code", "a b"), ("state", "s")],
        );
        assert_eq!(url, "https://a.example/cb?x=1&code=a+b&state=s");
    }

    #[test]
    fn random_tokens_are_long_and_distinct() {
        let a = random_token();
        assert_eq!(a.len(), 43);
        assert_ne!(a, random_token());
    }
}
