"""Tests for the MCP server (POST /mcp) and its OAuth authorization server
(/.well-known/*, /oauth/register|authorize|token|revoke, /mcp/files/*).

Image generation itself needs an online imggen agent, so only the agent-free tools
(placeholders, prompt library, job listing, argument validation) run end to end here.
"""

import base64
import hashlib
import os
import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from .helpers import auth_headers

CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def pkce_pair() -> tuple[str, str]:
    verifier = b64url(os.urandom(32))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def register_client(client: httpx.Client, redirect_uris=None, name="itest client") -> str:
    r = client.post(
        "/oauth/register",
        json={"client_name": name, "redirect_uris": redirect_uris or [CLAUDE_CALLBACK]},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["token_endpoint_auth_method"] == "none"
    return body["client_id"]


def authorize_params(client_id: str, challenge: str, redirect_uri=CLAUDE_CALLBACK, state="st-1") -> dict:
    return {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "scope": "mcp",
    }


def approve(client: httpx.Client, params: dict, user: dict, decision="allow") -> httpx.Response:
    form = {**params, "login": user["login"], "password": user["password"], "decision": decision}
    return client.post("/oauth/authorize", data=form, follow_redirects=False)


def redirect_query(r: httpx.Response) -> dict:
    assert r.status_code == 303, f"{r.status_code} {r.text[:300]}"
    return {k: v[0] for k, v in parse_qs(urlparse(r.headers["location"]).query).items()}


def exchange(client: httpx.Client, client_id: str, code: str, verifier: str, redirect_uri=CLAUDE_CALLBACK):
    return client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
        },
    )


def connect(client: httpx.Client, user: dict) -> dict:
    """Full DCR → authorize → token flow. Returns the token response plus client_id."""
    client_id = register_client(client)
    verifier, challenge = pkce_pair()
    q = redirect_query(approve(client, authorize_params(client_id, challenge), user))
    r = exchange(client, client_id, q["code"], verifier)
    assert r.status_code == 200, r.text
    return {**r.json(), "client_id": client_id}


def rpc(client: httpx.Client, token: str, method: str, params=None, id_=1, headers=None) -> httpx.Response:
    body = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        body["params"] = params
    return client.post("/mcp", json=body, headers={**auth_headers(token), **(headers or {})})


def tool(client: httpx.Client, token: str, name: str, args: dict) -> dict:
    r = rpc(client, token, "tools/call", {"name": name, "arguments": args})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "result" in body, body
    return body["result"]


def text_of(result: dict) -> str:
    return "\n".join(c["text"] for c in result["content"] if c["type"] == "text")


@pytest.fixture()
def tokens(client: httpx.Client, new_user: dict) -> dict:
    return connect(client, new_user)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


class TestDiscovery:
    def test_protected_resource_metadata(self, client: httpx.Client):
        for path in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"):
            r = client.get(path)
            assert r.status_code == 200
            body = r.json()
            assert body["resource"].endswith("/mcp")
            assert len(body["authorization_servers"]) == 1
            assert body["scopes_supported"] == ["mcp"]

    def test_authorization_server_metadata(self, client: httpx.Client):
        r = client.get("/.well-known/oauth-authorization-server")
        assert r.status_code == 200
        body = r.json()
        issuer = body["issuer"]
        for key in ("authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"):
            assert body[key].startswith(issuer + "/oauth/")
        assert body["code_challenge_methods_supported"] == ["S256"]
        assert "none" in body["token_endpoint_auth_methods_supported"]
        assert set(body["grant_types_supported"]) == {"authorization_code", "refresh_token"}

    def test_mcp_without_token_points_at_metadata(self, fresh_client: httpx.Client):
        r = fresh_client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert r.status_code == 401
        challenge = r.headers["www-authenticate"]
        assert challenge.startswith("Bearer ")
        assert 'resource_metadata="' in challenge
        assert "/.well-known/oauth-protected-resource/mcp" in challenge

    def test_mcp_with_bad_token_is_invalid_token(self, fresh_client: httpx.Client):
        r = rpc(fresh_client, "not-a-real-token", "tools/list")
        assert r.status_code == 401
        assert 'error="invalid_token"' in r.headers["www-authenticate"]


# ---------------------------------------------------------------------------
# Registration & authorization
# ---------------------------------------------------------------------------


class TestRegistration:
    @pytest.mark.parametrize(
        "uri",
        ["http://example.com/cb", "https://claude.ai/cb#frag", "javascript:alert(1)", "not a url"],
    )
    def test_rejects_unsafe_redirect_uris(self, client: httpx.Client, uri: str):
        r = client.post("/oauth/register", json={"client_name": "x", "redirect_uris": [uri]})
        assert r.status_code == 400
        assert r.json()["error"] == "invalid_redirect_uri"

    def test_requires_a_redirect_uri(self, client: httpx.Client):
        r = client.post("/oauth/register", json={"client_name": "x"})
        assert r.status_code == 400

    def test_malformed_json(self, client: httpx.Client):
        r = client.post("/oauth/register", content=b"{", headers={"content-type": "application/json"})
        assert r.status_code == 400
        assert r.json()["error"] == "invalid_client_metadata"


class TestAuthorize:
    def test_consent_page_renders(self, client: httpx.Client):
        client_id = register_client(client, name="Claude <script>")
        _, challenge = pkce_pair()
        r = client.get("/oauth/authorize", params=authorize_params(client_id, challenge))
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]
        assert r.headers["x-frame-options"] == "DENY"
        assert "claude.ai" in r.text
        assert "Claude &lt;script&gt;" in r.text  # client name is escaped
        assert 'name="password"' in r.text

    def test_unknown_client_is_an_error_page_not_a_redirect(self, client: httpx.Client):
        _, challenge = pkce_pair()
        r = client.get(
            "/oauth/authorize", params=authorize_params("nope", challenge), follow_redirects=False
        )
        assert r.status_code == 400
        assert "location" not in r.headers

    def test_unregistered_redirect_is_never_followed(self, client: httpx.Client):
        client_id = register_client(client)
        _, challenge = pkce_pair()
        params = authorize_params(client_id, challenge, redirect_uri="https://evil.example/cb")
        r = client.get("/oauth/authorize", params=params, follow_redirects=False)
        assert r.status_code == 400
        assert "location" not in r.headers

    def test_missing_pkce_redirects_with_error(self, client: httpx.Client):
        client_id = register_client(client)
        params = authorize_params(client_id, "x")
        del params["code_challenge"]
        q = redirect_query(client.get("/oauth/authorize", params=params, follow_redirects=False))
        assert q["error"] == "invalid_request"
        assert q["state"] == "st-1"

    def test_wrong_password_rerenders_the_form(self, client: httpx.Client, new_user: dict):
        client_id = register_client(client)
        _, challenge = pkce_pair()
        r = approve(client, authorize_params(client_id, challenge), {**new_user, "password": "wrong-pass"})
        assert r.status_code == 200
        assert "Wrong login or password" in r.text

    def test_deny_redirects_access_denied(self, client: httpx.Client, new_user: dict):
        client_id = register_client(client)
        _, challenge = pkce_pair()
        q = redirect_query(approve(client, authorize_params(client_id, challenge), new_user, decision="deny"))
        assert q["error"] == "access_denied"
        assert q["state"] == "st-1"
        assert "code" not in q

    def test_allow_returns_code_state_and_iss(self, client: httpx.Client, new_user: dict):
        client_id = register_client(client)
        _, challenge = pkce_pair()
        q = redirect_query(approve(client, authorize_params(client_id, challenge), new_user))
        assert q["code"]
        assert q["state"] == "st-1"
        assert q["iss"].startswith("http")

    def test_loopback_redirect_ignores_the_port(self, client: httpx.Client, new_user: dict):
        client_id = register_client(client, redirect_uris=["http://localhost/callback"])
        verifier, challenge = pkce_pair()
        redirect = "http://localhost:51234/callback"
        r = approve(client, authorize_params(client_id, challenge, redirect_uri=redirect), new_user)
        assert r.headers["location"].startswith(redirect + "?")
        q = redirect_query(r)
        tok = exchange(client, client_id, q["code"], verifier, redirect_uri=redirect)
        assert tok.status_code == 200, tok.text


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------


class TestTokens:
    def test_code_is_single_use(self, client: httpx.Client, new_user: dict):
        client_id = register_client(client)
        verifier, challenge = pkce_pair()
        q = redirect_query(approve(client, authorize_params(client_id, challenge), new_user))
        assert exchange(client, client_id, q["code"], verifier).status_code == 200
        r = exchange(client, client_id, q["code"], verifier)
        assert r.status_code == 400
        assert r.json()["error"] == "invalid_grant"

    def test_wrong_verifier_is_rejected(self, client: httpx.Client, new_user: dict):
        client_id = register_client(client)
        _, challenge = pkce_pair()
        other_verifier, _ = pkce_pair()
        q = redirect_query(approve(client, authorize_params(client_id, challenge), new_user))
        r = exchange(client, client_id, q["code"], other_verifier)
        assert r.status_code == 400
        assert r.json()["error"] == "invalid_grant"

    def test_unknown_client_is_invalid_client(self, client: httpx.Client):
        verifier, _ = pkce_pair()
        r = exchange(client, "no-such-client", "code", verifier)
        assert r.status_code == 401
        assert r.json()["error"] == "invalid_client"

    def test_token_response_shape(self, tokens: dict):
        assert tokens["token_type"] == "Bearer"
        assert tokens["expires_in"] > 0
        assert tokens["access_token"] and tokens["refresh_token"]

    def test_unsupported_grant_type(self, client: httpx.Client):
        r = client.post("/oauth/token", data={"grant_type": "client_credentials"})
        assert r.status_code == 400
        assert r.json()["error"] == "unsupported_grant_type"

    def test_refresh_rotates(self, client: httpx.Client, tokens: dict):
        refresh = {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": tokens["client_id"]}
        r = client.post("/oauth/token", data=refresh)
        assert r.status_code == 200, r.text
        rotated = r.json()
        assert rotated["refresh_token"] != tokens["refresh_token"]
        assert rpc(client, rotated["access_token"], "tools/list").status_code == 200
        # The old refresh token is spent.
        again = client.post("/oauth/token", data=refresh)
        assert again.status_code == 400
        assert again.json()["error"] == "invalid_grant"

    def test_revoking_the_refresh_token_ends_the_connection(self, client: httpx.Client, tokens: dict):
        assert rpc(client, tokens["access_token"], "tools/list").status_code == 200
        r = client.post("/oauth/revoke", data={"token": tokens["refresh_token"]})
        assert r.status_code == 200
        assert rpc(client, tokens["access_token"], "tools/list").status_code == 401

    def test_revoke_unknown_token_is_ok(self, client: httpx.Client):
        assert client.post("/oauth/revoke", data={"token": "whatever"}).status_code == 200

    def test_password_change_revokes_connections(self, client: httpx.Client, new_user: dict):
        tok = connect(client, new_user)
        r = client.post(
            "/api/auth/change_password",
            headers=new_user["headers"],
            json={"current_password": new_user["password"], "new_password": "another-pass-123"},
        )
        assert r.status_code == 200, r.text
        assert rpc(client, tok["access_token"], "tools/list").status_code == 401

    def test_oai_jwt_is_also_accepted(self, client: httpx.Client, new_user: dict):
        r = rpc(client, new_user["token"], "tools/list")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# MCP protocol
# ---------------------------------------------------------------------------


class TestProtocol:
    def test_initialize_and_tools_list(self, client: httpx.Client, tokens: dict):
        token = tokens["access_token"]
        r = rpc(
            client,
            token,
            "initialize",
            {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "itest", "version": "1"}},
        )
        assert r.status_code == 200
        init = r.json()["result"]
        assert init["protocolVersion"] == "2025-06-18"
        assert "tools" in init["capabilities"]
        assert "mcp-session-id" not in r.headers

        r = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "method": "notifications/initialized"},
            headers=auth_headers(token),
        )
        assert r.status_code == 202

        r = rpc(client, token, "tools/list", headers={"MCP-Protocol-Version": "2025-06-18"})
        names = {t["name"] for t in r.json()["result"]["tools"]}
        assert {"generate_images", "get_image_job", "list_image_models", "list_saved_prompts", "expand_prompt"} <= names

    def test_modern_revision(self, client: httpx.Client, tokens: dict):
        token = tokens["access_token"]
        meta = {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}
        hdrs = {"MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover"}
        r = rpc(client, token, "server/discover", {"_meta": meta}, headers=hdrs)
        assert r.status_code == 200
        assert "2026-07-28" in r.json()["result"]["supportedVersions"]

        r = rpc(client, token, "tools/list", {"_meta": {"io.modelcontextprotocol/protocolVersion": "1999-01-01"}})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == -32022

    def test_get_is_not_allowed(self, client: httpx.Client, tokens: dict):
        r = client.get("/mcp", headers=auth_headers(tokens["access_token"]))
        assert r.status_code == 405

    def test_foreign_origin_is_rejected(self, client: httpx.Client, tokens: dict):
        r = rpc(client, tokens["access_token"], "ping", headers={"Origin": "https://evil.example"})
        assert r.status_code == 403

    def test_parse_error(self, client: httpx.Client, tokens: dict):
        r = client.post(
            "/mcp",
            content=b"{",
            headers={**auth_headers(tokens["access_token"]), "content-type": "application/json"},
        )
        assert r.status_code == 400
        assert r.json()["error"]["code"] == -32700


# ---------------------------------------------------------------------------
# Tools (agent-free)
# ---------------------------------------------------------------------------


class TestTools:
    def test_placeholder_lifecycle_and_expansion(self, client: httpx.Client, tokens: dict):
        token = tokens["access_token"]
        name = f"zz{uuid.uuid4().hex[:6]}"
        res = tool(client, token, "save_placeholder", {"name": "{" + name + "}", "variants": ["red fox"]})
        assert not res["isError"], res
        res = tool(client, token, "save_placeholder", {"name": name, "add_variants": ["blue whale"]})
        assert res["structuredContent"]["variants"] == ["red fox", "blue whale"]
        res = tool(client, token, "save_placeholder", {"name": name, "remove_variants": ["red fox"]})
        assert res["structuredContent"]["variants"] == ["blue whale"]

        listed = tool(client, token, "list_placeholders", {})
        assert any(p["name"] == name for p in listed["structuredContent"]["custom"])

        res = tool(client, token, "expand_prompt", {"prompt": "a {" + name + "} and {?}", "count": 2})
        assert res["structuredContent"]["expansions"] == ["a blue whale and {?}"] * 2

        res = tool(client, token, "expand_prompt", {"prompt": "{color}", "count": 3})
        values = res["structuredContent"]["expansions"]
        assert len(set(values)) == 3 and all("{" not in v for v in values)

        res = tool(client, token, "delete_placeholders", {"names": [name]})
        assert "deleted" in text_of(res)

    def test_reserved_placeholder_name_is_a_tool_error(self, client: httpx.Client, tokens: dict):
        res = tool(client, tokens["access_token"], "save_placeholder", {"name": "color", "variants": ["x"]})
        assert res["isError"]
        assert "reserved" in text_of(res)

    def test_prompt_library_round_trip(self, client: httpx.Client, tokens: dict):
        token = tokens["access_token"]
        text = f"zz-mcp-test {uuid.uuid4().hex}"
        res = tool(client, token, "star_prompt", {"text": text})
        assert not res["isError"], res
        entry_id = res["structuredContent"]["entry_id"]

        listed = tool(client, token, "list_saved_prompts", {"kind": "starred", "query": text})
        assert [i["entry_id"] for i in listed["structuredContent"]["items"]] == [entry_id]

        got = tool(client, token, "get_saved_prompt", {"entry_id": entry_id})
        assert text_of(got) == text

        edited = tool(client, token, "edit_saved_prompt", {"entry_id": entry_id, "content": text + " v2"})
        assert edited["structuredContent"]["content"] == text + " v2"

        res = tool(client, token, "star_prompt", {"text": text + " v2", "starred": False})
        assert not res["isError"], res
        listed = tool(client, token, "list_saved_prompts", {"kind": "starred", "query": text})
        assert listed["structuredContent"]["items"] == []

    def test_job_tools_without_jobs(self, client: httpx.Client, tokens: dict):
        token = tokens["access_token"]
        res = tool(client, token, "list_image_jobs", {})
        assert text_of(res) == "No matching image jobs."
        res = tool(client, token, "get_image_job", {"job_id": "123"})
        assert res["isError"]
        res = tool(client, token, "view_image", {"image_id": "123"})
        assert res["isError"]

    def test_generate_validates_arguments_before_submitting(self, client: httpx.Client, tokens: dict):
        token = tokens["access_token"]
        for args in ({"prompt": "  "}, {"prompt": "x", "count": 0}, {"prompt": "x", "wait_seconds": 9999}, {"prompt": "x", "width": 5}):
            res = tool(client, token, "generate_images", args)
            assert res["isError"], args

    def test_invalid_arguments_are_a_tool_error(self, client: httpx.Client, tokens: dict):
        res = tool(client, tokens["access_token"], "get_image_job", {"job_id": "abc"})
        assert res["isError"]
        assert "invalid arguments" in text_of(res)

    def test_unknown_tool_is_a_protocol_error(self, client: httpx.Client, tokens: dict):
        r = rpc(client, tokens["access_token"], "tools/call", {"name": "nope", "arguments": {}})
        assert r.json()["error"]["code"] == -32602


class TestSignedLinks:
    def test_bad_or_expired_signatures_are_forbidden(self, fresh_client: httpx.Client):
        assert fresh_client.get("/mcp/files/1", params={"u": 1, "exp": 9999999999, "sig": "00"}).status_code == 403
        assert fresh_client.get("/mcp/files/1", params={"u": 1, "exp": 1, "sig": "00"}).status_code == 403
        assert fresh_client.get("/mcp/files/1").status_code == 400
