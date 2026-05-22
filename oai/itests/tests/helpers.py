"""Shared helper utilities for OAI integration tests."""

import httpx


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def register(client: httpx.Client, login: str, password: str = "testpass123") -> dict:
    """Register a user and return the response body. Raises on non-200."""
    r = client.post("/api/auth/register", json={"login": login, "password": password})
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    return r.json()


def login(client: httpx.Client, login_str: str, password: str = "testpass123") -> str:
    """Log in and return the token. Raises on non-200."""
    r = client.post("/api/auth/login", json={"login": login_str, "password": password})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]
