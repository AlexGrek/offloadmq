"""Tests for POST /api/auth/change_password."""

import httpx

from helpers import login


class TestChangePasswordSuccess:
    def test_returns_200_and_ok(self, client: httpx.Client, fresh_user: dict):
        r = client.post(
            "/api/auth/change_password",
            headers=fresh_user["headers"],
            json={
                "current_password": fresh_user["password"],
                "new_password": "newpass456",
            },
        )
        assert r.status_code == 200
        assert r.json() == {"ok": True}

    def test_can_login_with_new_password(self, client: httpx.Client, fresh_user: dict):
        client.post(
            "/api/auth/change_password",
            headers=fresh_user["headers"],
            json={
                "current_password": fresh_user["password"],
                "new_password": "newpass456",
            },
        )
        token = login(client, fresh_user["login"], "newpass456")
        assert token

    def test_old_password_rejected_after_change(
        self, client: httpx.Client, fresh_user: dict
    ):
        client.post(
            "/api/auth/change_password",
            headers=fresh_user["headers"],
            json={
                "current_password": fresh_user["password"],
                "new_password": "newpass456",
            },
        )
        r = client.post(
            "/api/auth/login",
            json={"login": fresh_user["login"], "password": fresh_user["password"]},
        )
        assert r.status_code == 401


class TestChangePasswordValidation:
    def test_wrong_current_password_returns_401(
        self, client: httpx.Client, fresh_user: dict
    ):
        r = client.post(
            "/api/auth/change_password",
            headers=fresh_user["headers"],
            json={
                "current_password": "wrongpassword",
                "new_password": "newpass456",
            },
        )
        assert r.status_code == 401

    def test_short_new_password_returns_400(
        self, client: httpx.Client, fresh_user: dict
    ):
        r = client.post(
            "/api/auth/change_password",
            headers=fresh_user["headers"],
            json={
                "current_password": fresh_user["password"],
                "new_password": "abc12",
            },
        )
        assert r.status_code == 400
        assert "6 characters" in r.json()["error"]

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.post(
            "/api/auth/change_password",
            json={"current_password": "x", "new_password": "newpass456"},
        )
        assert r.status_code == 401
