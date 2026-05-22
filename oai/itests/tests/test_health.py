"""Tests for GET /api/health."""

import httpx


class TestHealth:
    def test_returns_200(self, client: httpx.Client):
        r = client.get("/api/health")
        assert r.status_code == 200

    def test_status_ok(self, client: httpx.Client):
        body = client.get("/api/health").json()
        assert body["status"] == "ok"

    def test_no_auth_required(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/health")
        assert r.status_code == 200
