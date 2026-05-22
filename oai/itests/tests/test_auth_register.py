"""Tests for POST /api/auth/register."""

import httpx


class TestRegisterSuccess:
    def test_returns_200(self, client: httpx.Client, unique_login: str):
        r = client.post("/api/auth/register", json={"login": unique_login, "password": "testpass123"})
        assert r.status_code == 200

    def test_returns_token(self, client: httpx.Client, unique_login: str):
        r = client.post("/api/auth/register", json={"login": unique_login, "password": "testpass123"})
        body = r.json()
        assert "token" in body
        assert isinstance(body["token"], str)
        assert body["token"]

    def test_returns_user_id(self, client: httpx.Client, unique_login: str):
        r = client.post("/api/auth/register", json={"login": unique_login, "password": "testpass123"})
        body = r.json()
        assert "user_id" in body
        assert isinstance(body["user_id"], int)

    def test_token_authenticates_me(self, client: httpx.Client, unique_login: str):
        r = client.post("/api/auth/register", json={"login": unique_login, "password": "testpass123"})
        token = r.json()["token"]
        me = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
        assert me.status_code == 200

    def test_min_password_length_accepted(self, client: httpx.Client, unique_login: str):
        r = client.post("/api/auth/register", json={"login": unique_login, "password": "6chars"})
        assert r.status_code == 200


class TestRegisterValidation:
    def test_empty_login_returns_400(self, client: httpx.Client):
        r = client.post("/api/auth/register", json={"login": "", "password": "testpass123"})
        assert r.status_code == 400

    def test_whitespace_login_returns_400(self, client: httpx.Client):
        r = client.post("/api/auth/register", json={"login": "   ", "password": "testpass123"})
        assert r.status_code == 400

    def test_short_password_returns_400(self, client: httpx.Client, unique_login: str):
        r = client.post("/api/auth/register", json={"login": unique_login, "password": "abc12"})
        assert r.status_code == 400

    def test_duplicate_login_returns_400(self, client: httpx.Client, registered_user: dict):
        r = client.post(
            "/api/auth/register",
            json={"login": registered_user["login"], "password": "testpass123"},
        )
        assert r.status_code == 400
        assert "taken" in r.json()["error"].lower()

    def test_error_body_has_error_key(self, client: httpx.Client):
        r = client.post("/api/auth/register", json={"login": "", "password": "testpass123"})
        body = r.json()
        assert "error" in body
        assert isinstance(body["error"], str)

    def test_missing_fields_returns_422(self, client: httpx.Client):
        r = client.post("/api/auth/register", json={"login": "only_login"})
        assert r.status_code == 422
