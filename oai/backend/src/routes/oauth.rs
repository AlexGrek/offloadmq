//! HTTP surface of the MCP OAuth authorization server: discovery metadata, Dynamic
//! Client Registration, the sign-in/consent page, token and revocation endpoints.
//! Protocol logic lives in `services::oauth`.

use std::sync::Arc;

use axum::{
    Form, Json,
    extract::{Query, State, rejection::FormRejection, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Redirect, Response},
};
use serde::Deserialize;

use crate::{
    db::users,
    error::{AppError, ResultExt},
    services::oauth::{
        self, AuthorizeError, AuthorizeParams, OAuthError, TokenRequest, ValidAuthorize,
    },
    state::AppState,
};

fn no_store(mut resp: Response) -> Response {
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

/// `GET /.well-known/oauth-protected-resource[/mcp]` (RFC 9728).
pub async fn protected_resource_metadata(headers: HeaderMap) -> Json<serde_json::Value> {
    Json(oauth::protected_resource_metadata(&oauth::public_base_url(
        &headers,
    )))
}

/// `GET /.well-known/oauth-authorization-server` (RFC 8414), also served at the
/// OpenID discovery path for clients that only probe that one.
pub async fn authorization_server_metadata(headers: HeaderMap) -> Json<serde_json::Value> {
    Json(oauth::authorization_server_metadata(
        &oauth::public_base_url(&headers),
    ))
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    #[serde(default)]
    pub client_name: Option<String>,
    #[serde(default)]
    pub redirect_uris: Vec<String>,
}

/// `POST /oauth/register` — RFC 7591 Dynamic Client Registration (public clients).
pub async fn register(
    State(state): State<Arc<AppState>>,
    body: Result<Json<RegisterRequest>, JsonRejection>,
) -> Response {
    let Json(req) = match body {
        Ok(b) => b,
        Err(e) => return OAuthError::invalid_client_metadata(e.body_text()).into_response(),
    };
    match oauth::register_client(&state, req.client_name, req.redirect_uris).await {
        Ok(client) => no_store((StatusCode::CREATED, Json(client)).into_response()),
        Err(e) => e.into_response(),
    }
}

/// `GET /oauth/authorize` — validates the request and shows the sign-in/consent page.
pub async fn authorize_page(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<AuthorizeParams>,
) -> Response {
    let base = oauth::public_base_url(&headers);
    match oauth::validate_authorize(&state, &base, &params).await {
        Ok(req) => consent_page(&req, &params, None),
        Err(e) => authorize_error_response(&base, e),
    }
}

/// The consent form: the authorization request echoed back as hidden fields, plus the
/// user's credentials and their decision.
#[derive(Deserialize)]
pub struct AuthorizeForm {
    #[serde(default)]
    response_type: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    redirect_uri: Option<String>,
    #[serde(default)]
    code_challenge: Option<String>,
    #[serde(default)]
    code_challenge_method: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    resource: Option<String>,
    #[serde(default)]
    login: String,
    #[serde(default)]
    password: String,
    /// `allow` or `deny`.
    #[serde(default)]
    decision: String,
}

/// `POST /oauth/authorize` — the consent form submission. Rate limited per IP (it runs
/// bcrypt); every request parameter is re-validated, the form is not trusted.
pub async fn authorize_submit(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Form(form): Form<AuthorizeForm>,
) -> Response {
    let base = oauth::public_base_url(&headers);
    let params = AuthorizeParams {
        response_type: form.response_type,
        client_id: form.client_id,
        redirect_uri: form.redirect_uri,
        code_challenge: form.code_challenge,
        code_challenge_method: form.code_challenge_method,
        state: form.state,
        scope: form.scope,
        resource: form.resource,
    };
    let req = match oauth::validate_authorize(&state, &base, &params).await {
        Ok(req) => req,
        Err(e) => return authorize_error_response(&base, e),
    };

    if form.decision != "allow" {
        return authorize_error_response(
            &base,
            AuthorizeError::Redirect {
                redirect_uri: req.redirect_uri,
                state: req.state,
                error: "access_denied",
                description: "the user denied access".into(),
            },
        );
    }

    let user_id = match check_credentials(&state, form.login.trim(), form.password).await {
        Ok(Some(id)) => id,
        Ok(None) => return consent_page(&req, &params, Some("Wrong login or password.")),
        Err(e) => {
            tracing::error!("oauth sign-in failed: {e:?}");
            return consent_page(&req, &params, Some("Sign-in failed. Please try again."));
        }
    };

    match oauth::issue_code(&state, &req, user_id).await {
        Ok(code) => {
            let mut q: Vec<(&str, &str)> = vec![("code", &code), ("iss", &base)];
            if let Some(s) = req.state.as_deref() {
                q.push(("state", s));
            }
            // 303 so the browser follows with a GET.
            no_store(Redirect::to(&oauth::redirect_with(&req.redirect_uri, &q)).into_response())
        }
        Err(e) => {
            tracing::error!("oauth code issue failed: {e:?}");
            consent_page(&req, &params, Some("Sign-in failed. Please try again."))
        }
    }
}

/// Same checks as `routes::auth::login`, including the dummy bcrypt for unknown logins
/// so timing doesn't reveal which accounts exist.
async fn check_credentials(
    state: &AppState,
    login: &str,
    password: String,
) -> Result<Option<i64>, AppError> {
    let found = users::find_by_login(&state.db, login)
        .await?
        .and_then(|u| u.password_hash.clone().map(|h| (u, h)));
    let Some((user, hash)) = found else {
        state.auth.verify_dummy(password).await;
        return Ok(None);
    };
    if state.auth.verify_password(password, hash).await? {
        Ok(Some(user.id))
    } else {
        Ok(None)
    }
}

/// `POST /oauth/token` — authorization_code and refresh_token grants
/// (`application/x-www-form-urlencoded`, RFC 6749).
pub async fn token(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Result<Form<TokenRequest>, FormRejection>,
) -> Response {
    let Form(req) = match body {
        Ok(b) => b,
        Err(e) => return OAuthError::invalid_request(e.body_text()).into_response(),
    };
    let base = oauth::public_base_url(&headers);
    match oauth::token(&state, &base, req).await {
        Ok(tokens) => no_store(Json(tokens).into_response()),
        Err(e) => e.into_response(),
    }
}

#[derive(Deserialize)]
pub struct RevokeRequest {
    #[serde(default)]
    token: String,
}

/// `POST /oauth/revoke` — RFC 7009. Always 200, whether or not the token existed.
pub async fn revoke(
    State(state): State<Arc<AppState>>,
    body: Result<Form<RevokeRequest>, FormRejection>,
) -> Response {
    let Form(req) = match body {
        Ok(b) => b,
        Err(e) => return OAuthError::invalid_request(e.body_text()).into_response(),
    };
    if !req.token.is_empty() {
        oauth::revoke(&state, &req.token)
            .await
            .log_warn("oauth revoke");
    }
    no_store(StatusCode::OK.into_response())
}

// ── HTML ─────────────────────────────────────────────────────────────────────

fn authorize_error_response(base: &str, err: AuthorizeError) -> Response {
    match err {
        AuthorizeError::Fatal(message) => html_page(
            StatusCode::BAD_REQUEST,
            "Can't connect",
            &format!("<p class=\"err\">{}</p>", escape(&message)),
        ),
        AuthorizeError::Redirect {
            redirect_uri,
            state,
            error,
            description,
        } => {
            let mut q: Vec<(&str, &str)> = vec![
                ("error", error),
                ("error_description", &description),
                ("iss", base),
            ];
            if let Some(s) = state.as_deref() {
                q.push(("state", s));
            }
            no_store(Redirect::to(&oauth::redirect_with(&redirect_uri, &q)).into_response())
        }
    }
}

fn consent_page(req: &ValidAuthorize, params: &AuthorizeParams, error: Option<&str>) -> Response {
    let redirect_host = reqwest::Url::parse(&req.redirect_uri)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| req.redirect_uri.clone());
    let loopback = matches!(redirect_host.as_str(), "localhost" | "127.0.0.1" | "[::1]");

    let hidden = |name: &str, value: Option<&str>| -> String {
        value
            .map(|v| {
                format!(
                    "<input type=\"hidden\" name=\"{name}\" value=\"{}\">",
                    escape(v)
                )
            })
            .unwrap_or_default()
    };
    let hidden_fields = [
        hidden("response_type", params.response_type.as_deref()),
        hidden("client_id", Some(&req.client.client_id)),
        hidden("redirect_uri", Some(&req.redirect_uri)),
        hidden("code_challenge", Some(&req.code_challenge)),
        hidden(
            "code_challenge_method",
            params.code_challenge_method.as_deref(),
        ),
        hidden("state", req.state.as_deref()),
        hidden("scope", params.scope.as_deref()),
        hidden("resource", req.resource.as_deref()),
    ]
    .concat();

    let error_html = error
        .map(|e| format!("<p class=\"err\">{}</p>", escape(e)))
        .unwrap_or_default();
    let loopback_warning = if loopback {
        "<p class=\"warn\">This app runs on your own computer. Only continue if you just \
         started this connection yourself.</p>"
    } else {
        ""
    };

    let body = format!(
        r#"<p><b>{client}</b> wants to use your OAI account to generate images and manage your
image jobs, saved prompts and placeholders.</p>
<p class="muted">You will be returned to <b>{host}</b>.</p>
{loopback_warning}
{error_html}
<form method="post" action="/oauth/authorize">
{hidden_fields}
<label>Login<input name="login" autocomplete="username" autocapitalize="none" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<div class="row">
<button type="submit" name="decision" value="deny" class="secondary" formnovalidate>Deny</button>
<button type="submit" name="decision" value="allow">Allow</button>
</div>
</form>"#,
        client = escape(&req.client.client_name),
        host = escape(&redirect_host),
    );
    html_page(StatusCode::OK, "Connect to OAI", &body)
}

fn html_page(status: StatusCode, title: &str, body: &str) -> Response {
    let page = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<style>
body{{font-family:system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f5;color:#18181b}}
main{{background:#fff;max-width:380px;width:100%;margin:16px;padding:24px;border-radius:14px;box-shadow:0 1px 8px rgba(0,0,0,.08)}}
h1{{font-size:1.25rem;margin:0 0 12px}}
p{{line-height:1.45;margin:0 0 12px}}
.muted{{color:#71717a;font-size:.92rem}}
.err{{color:#b91c1c}}
.warn{{color:#a16207}}
label{{display:block;font-size:.9rem;margin:12px 0 0}}
input{{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px 12px;font-size:1rem;border:1px solid #d4d4d8;border-radius:8px;background:inherit;color:inherit}}
.row{{display:flex;gap:10px;margin-top:20px}}
button{{flex:1;padding:11px;font-size:1rem;border:0;border-radius:8px;background:#18181b;color:#fff;cursor:pointer}}
button.secondary{{background:#e4e4e7;color:#18181b}}
@media (prefers-color-scheme:dark){{body{{background:#09090b;color:#fafafa}}main{{background:#18181b}}input{{border-color:#3f3f46}}button{{background:#fafafa;color:#09090b}}button.secondary{{background:#27272a;color:#fafafa}}}}
</style>
</head>
<body><main><h1>{title}</h1>
{body}
</main></body>
</html>"#,
        title = escape(title),
    );
    let mut resp = (status, Html(page)).into_response();
    let h = resp.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        ),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    resp
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_neutralizes_markup() {
        assert_eq!(
            escape(r#"<a href="x">'&'</a>"#),
            "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
        );
    }
}
