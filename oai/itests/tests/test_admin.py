"""Tests for /api/admin/* endpoints."""

import httpx


class TestAmIAdmin:
    def test_returns_200_for_authenticated_user(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/admin/am_i_admin", headers=session_headers)
        assert r.status_code == 200

    def test_regular_user_is_not_admin(self, client: httpx.Client, session_headers: dict):
        body = client.get("/api/admin/am_i_admin", headers=session_headers).json()
        assert body["is_admin"] is False

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/admin/am_i_admin")
        assert r.status_code == 401

    def test_response_has_is_admin_key(self, client: httpx.Client, session_headers: dict):
        body = client.get("/api/admin/am_i_admin", headers=session_headers).json()
        assert "is_admin" in body
        assert isinstance(body["is_admin"], bool)


class TestAdminSettingsAccess:
    """Admin-only routes return 403 for non-admin users, 401 for unauthenticated."""

    def test_get_settings_requires_admin(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/admin/settings", headers=session_headers)
        assert r.status_code == 403

    def test_post_settings_requires_admin(self, client: httpx.Client, session_headers: dict):
        r = client.post(
            "/api/admin/settings",
            headers=session_headers,
            json={"offloadmq_url": "http://localhost:3069", "client_api_token": None, "management_api_token": None},
        )
        assert r.status_code == 403

    def test_get_settings_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/admin/settings")
        assert r.status_code == 401

    def test_admin_image_jobs_requires_admin(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/admin/images/jobs", headers=session_headers)
        assert r.status_code == 403

    def test_admin_image_files_requires_admin(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/admin/images/files", headers=session_headers)
        assert r.status_code == 403

    def test_k8s_self_pod_requires_admin(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/admin/k8s/self/pod", headers=session_headers)
        assert r.status_code == 403

    def test_k8s_self_logs_requires_admin(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/admin/k8s/self/logs", headers=session_headers)
        assert r.status_code == 403

    def test_k8s_self_pod_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/admin/k8s/self/pod")
        assert r.status_code == 401

    def test_diagnostics_logs_requires_admin(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/admin/k8s/self/logs?component=app&tail_lines=100", headers=session_headers)
        assert r.status_code == 403
