"""Tests for GET /api/version (build-version probe used by the SPA reload check)."""

import httpx


class TestVersion:
    def test_returns_200(self, client: httpx.Client):
        r = client.get("/api/version")
        assert r.status_code == 200

    def test_has_version_field(self, client: httpx.Client):
        body = client.get("/api/version").json()
        assert isinstance(body["version"], str)
        assert body["version"]

    def test_no_auth_required(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/version")
        assert r.status_code == 200

    def test_health_reports_same_version(self, client: httpx.Client):
        version = client.get("/api/version").json()["version"]
        health = client.get("/api/health").json()
        assert health["version"] == version
