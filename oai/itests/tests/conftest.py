"""Shared fixtures for OAI integration tests."""

import os
import uuid

import httpx
import pytest

from .helpers import auth_headers, register, login as do_login


BASE_URL = os.environ.get("OAI_BASE_URL", "http://localhost:3001")


# ---------------------------------------------------------------------------
# HTTP clients
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def base_url() -> str:
    return BASE_URL


@pytest.fixture(scope="session")
def client(base_url: str) -> httpx.Client:
    """Session-scoped HTTP client pointed at the API."""
    with httpx.Client(base_url=base_url, timeout=10) as c:
        yield c


@pytest.fixture()
def fresh_client(base_url: str) -> httpx.Client:
    """Function-scoped client with a clean state — use for auth-negative tests."""
    with httpx.Client(base_url=base_url, timeout=10) as c:
        yield c


# ---------------------------------------------------------------------------
# User fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def unique_login() -> str:
    """A unique login string for test isolation."""
    return f"user_{uuid.uuid4().hex[:12]}"


@pytest.fixture(scope="session")
def registered_user(client: httpx.Client) -> dict:
    """Register a unique user once per session. Returns {login, password, user_id, token}."""
    login_str = f"session_{uuid.uuid4().hex[:12]}"
    password = "testpass123"
    body = register(client, login_str, password)
    return {"login": login_str, "password": password, "user_id": body["user_id"], "token": body["token"]}


@pytest.fixture(scope="session")
def session_token(registered_user: dict) -> str:
    """JWT token for the session-registered user."""
    return registered_user["token"]


@pytest.fixture(scope="session")
def session_headers(session_token: str) -> dict[str, str]:
    return auth_headers(session_token)


@pytest.fixture()
def new_user(client: httpx.Client) -> dict:
    """Register a fresh user per test. Returns {login, password, user_id, token, headers}."""
    login_str = f"fresh_{uuid.uuid4().hex[:12]}"
    password = "testpass123"
    body = register(client, login_str, password)
    token = body["token"]
    return {
        "login": login_str,
        "password": password,
        "user_id": body["user_id"],
        "token": token,
        "headers": auth_headers(token),
    }
