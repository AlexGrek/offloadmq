"""Tests for GET/PUT /api/me/reverse-exclusions (reverse-substitution registry)."""

import httpx


class TestReverseExclusions:
    def test_default_is_empty(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/me/reverse-exclusions", headers=session_headers)
        assert r.status_code == 200
        assert r.json() == {"words": [], "placeholders": []}

    def test_save_normalizes_and_persists(self, client: httpx.Client, session_headers: dict):
        body = {"words": ["  Red ", "red", "big  cat", ""], "placeholders": ["{Adjective}", "adjective"]}
        r = client.put("/api/me/reverse-exclusions", headers=session_headers, json=body)
        assert r.status_code == 200
        assert r.json() == {"words": ["Red", "big cat"], "placeholders": ["adjective"]}
        r = client.get("/api/me/reverse-exclusions", headers=session_headers)
        assert r.json() == {"words": ["Red", "big cat"], "placeholders": ["adjective"]}

    def test_rejects_invalid_placeholder(self, client: httpx.Client, session_headers: dict):
        r = client.put(
            "/api/me/reverse-exclusions",
            headers=session_headers,
            json={"words": [], "placeholders": ["bad name!"]},
        )
        assert r.status_code == 400

    def test_requires_auth(self, client: httpx.Client):
        assert client.get("/api/me/reverse-exclusions").status_code == 401
