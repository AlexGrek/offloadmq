"""Tests for GET /api/me."""

import httpx


class TestMeSuccess:
    def test_returns_200(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/me", headers=session_headers)
        assert r.status_code == 200

    def test_returns_correct_user_id(self, client: httpx.Client, registered_user: dict, session_headers: dict):
        r = client.get("/api/me", headers=session_headers)
        assert r.json()["id"] == registered_user["user_id"]

    def test_returns_correct_login(self, client: httpx.Client, registered_user: dict, session_headers: dict):
        r = client.get("/api/me", headers=session_headers)
        assert r.json()["login"] == registered_user["login"]

    def test_response_shape(self, client: httpx.Client, session_headers: dict):
        body = client.get("/api/me", headers=session_headers).json()
        assert "id" in body
        assert "login" in body
        assert "created_at" in body


class TestMeAuth:
    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/me")
        assert r.status_code == 401

    def test_invalid_token_returns_401(self, client: httpx.Client):
        r = client.get("/api/me", headers={"Authorization": "Bearer not.a.valid.jwt"})
        assert r.status_code == 401

    def test_malformed_header_returns_401(self, client: httpx.Client):
        r = client.get("/api/me", headers={"Authorization": "Token sometoken"})
        assert r.status_code == 401
