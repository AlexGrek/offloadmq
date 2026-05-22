"""Tests for POST /api/auth/login."""

import httpx


class TestLoginSuccess:
    def test_returns_200(self, client: httpx.Client, registered_user: dict):
        r = client.post(
            "/api/auth/login",
            json={"login": registered_user["login"], "password": registered_user["password"]},
        )
        assert r.status_code == 200

    def test_returns_token(self, client: httpx.Client, registered_user: dict):
        r = client.post(
            "/api/auth/login",
            json={"login": registered_user["login"], "password": registered_user["password"]},
        )
        body = r.json()
        assert "token" in body
        assert isinstance(body["token"], str)
        assert body["token"]

    def test_returns_user_id(self, client: httpx.Client, registered_user: dict):
        r = client.post(
            "/api/auth/login",
            json={"login": registered_user["login"], "password": registered_user["password"]},
        )
        assert r.json()["user_id"] == registered_user["user_id"]

    def test_token_authenticates_me(self, client: httpx.Client, registered_user: dict):
        r = client.post(
            "/api/auth/login",
            json={"login": registered_user["login"], "password": registered_user["password"]},
        )
        token = r.json()["token"]
        me = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
        assert me.status_code == 200
        assert me.json()["id"] == registered_user["user_id"]


class TestLoginFailure:
    def test_wrong_password_returns_401(self, client: httpx.Client, registered_user: dict):
        r = client.post(
            "/api/auth/login",
            json={"login": registered_user["login"], "password": "wrongpassword"},
        )
        assert r.status_code == 401

    def test_unknown_login_returns_401(self, client: httpx.Client):
        r = client.post(
            "/api/auth/login",
            json={"login": "no_such_user_xyz_9999", "password": "testpass123"},
        )
        assert r.status_code == 401

    def test_error_body_has_error_key(self, client: httpx.Client, registered_user: dict):
        r = client.post(
            "/api/auth/login",
            json={"login": registered_user["login"], "password": "wrong"},
        )
        body = r.json()
        assert "error" in body
        assert isinstance(body["error"], str)

    def test_missing_fields_returns_422(self, client: httpx.Client):
        r = client.post("/api/auth/login", json={"login": "someone"})
        assert r.status_code == 422
