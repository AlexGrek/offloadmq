"""Tests for /api/images/* endpoints.

These exercise the MQ-independent contract only: auth, id parsing, and not-found
behavior. A full generation submit calls OffloadMQ (needs an online imggen agent),
so the happy path of POST /api/images/jobs is not asserted here — only that the
request schema is accepted and the route is protected.

Routes whose 404 lives behind `storage::operator` (poll, file download) are tested
for auth + invalid-id only, since their not-found status is storage-config dependent.
"""

import httpx

# Numeric but (practically) never-assigned snowflake id — exercises the not-found path.
MISSING_ID = "999999999999999999"
INVALID_ID = "not-a-number"
GARBAGE_TOKEN = {"Authorization": "Bearer not.a.valid.jwt"}


def _assert_error_shape(r: httpx.Response) -> None:
    """AppError responses carry a flat `{"error": "<str>"}` body."""
    body = r.json()
    assert isinstance(body["error"], str)


class TestListImageJobs:
    def test_returns_200_and_list(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/images/jobs", headers=session_headers)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_new_user_sees_empty_list(self, client: httpx.Client, new_user: dict):
        r = client.get("/api/images/jobs", headers=new_user["headers"])
        assert r.status_code == 200
        assert r.json() == []

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/images/jobs")
        assert r.status_code == 401

    def test_invalid_token_returns_401(self, client: httpx.Client):
        r = client.get("/api/images/jobs", headers=GARBAGE_TOKEN)
        assert r.status_code == 401


class TestListImgGenCapabilities:
    def test_returns_200_and_list(self, client: httpx.Client, session_headers: dict):
        # Returns DB-known caps (offline) even when no client token is configured.
        r = client.get("/api/images/capabilities", headers=session_headers)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/images/capabilities")
        assert r.status_code == 401


class TestGetImageJob:
    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.get(f"/api/images/jobs/{MISSING_ID}")
        assert r.status_code == 401

    def test_invalid_id_returns_400(self, client: httpx.Client, session_headers: dict):
        r = client.get(f"/api/images/jobs/{INVALID_ID}", headers=session_headers)
        assert r.status_code == 400
        _assert_error_shape(r)

    def test_missing_job_returns_404(self, client: httpx.Client, session_headers: dict):
        r = client.get(f"/api/images/jobs/{MISSING_ID}", headers=session_headers)
        assert r.status_code == 404
        _assert_error_shape(r)


class TestDeleteImageJob:
    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.delete(f"/api/images/jobs/{MISSING_ID}")
        assert r.status_code == 401

    def test_invalid_id_returns_400(self, client: httpx.Client, session_headers: dict):
        r = client.delete(f"/api/images/jobs/{INVALID_ID}", headers=session_headers)
        assert r.status_code == 400

    def test_missing_job_returns_404(self, client: httpx.Client, new_user: dict):
        r = client.delete(f"/api/images/jobs/{MISSING_ID}", headers=new_user["headers"])
        assert r.status_code == 404


class TestCancelImageJob:
    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.post(f"/api/images/jobs/{MISSING_ID}/cancel")
        assert r.status_code == 401

    def test_invalid_id_returns_400(self, client: httpx.Client, session_headers: dict):
        r = client.post(f"/api/images/jobs/{INVALID_ID}/cancel", headers=session_headers)
        assert r.status_code == 400

    def test_missing_job_returns_404(self, client: httpx.Client, session_headers: dict):
        r = client.post(f"/api/images/jobs/{MISSING_ID}/cancel", headers=session_headers)
        assert r.status_code == 404


class TestRetryImageJob:
    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.post(f"/api/images/jobs/{MISSING_ID}/retry")
        assert r.status_code == 401

    def test_invalid_id_returns_400(self, client: httpx.Client, session_headers: dict):
        r = client.post(f"/api/images/jobs/{INVALID_ID}/retry", headers=session_headers)
        assert r.status_code == 400

    def test_missing_job_returns_404(self, client: httpx.Client, session_headers: dict):
        r = client.post(f"/api/images/jobs/{MISSING_ID}/retry", headers=session_headers)
        assert r.status_code == 404


class TestPollImageJob:
    """poll runs `storage::operator` before the DB lookup, so its not-found status is
    storage-config dependent — only auth + id parsing are asserted."""

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.post(f"/api/images/jobs/{MISSING_ID}/poll")
        assert r.status_code == 401

    def test_invalid_id_returns_400(self, client: httpx.Client, session_headers: dict):
        r = client.post(f"/api/images/jobs/{INVALID_ID}/poll", headers=session_headers)
        assert r.status_code == 400


class TestGetImageFile:
    """File bytes are served behind `storage::operator`; only auth + id parsing are asserted."""

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.get(f"/api/images/files/{MISSING_ID}")
        assert r.status_code == 401

    def test_invalid_id_returns_400(self, client: httpx.Client, session_headers: dict):
        r = client.get(f"/api/images/files/{INVALID_ID}", headers=session_headers)
        assert r.status_code == 400


class TestStartImageJob:
    """A real submit calls OffloadMQ, so only auth + request-schema contract are asserted."""

    # Mirrors the body the frontend sends, including the resolution-toggle fields
    # (`data_preparation`, `rescale`, explicit width/height).
    _BODY = {
        "capability": "imggen.test",
        "prompt": "a contract test image",
        "override_negative": False,
        "width": 1024,
        "height": 768,
        "workflow": "txt2img",
        "data_preparation": None,
        "rescale": {"enabled": False, "mode": "exact", "width": 1024, "height": 768},
    }

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.post("/api/images/jobs", json=self._BODY)
        assert r.status_code == 401

    def test_invalid_token_returns_401(self, client: httpx.Client):
        r = client.post("/api/images/jobs", headers=GARBAGE_TOKEN, json=self._BODY)
        assert r.status_code == 401

    def test_missing_required_fields_rejected(self, client: httpx.Client, session_headers: dict):
        # `capability`, `prompt`, `width`, `height` are required (no serde default).
        r = client.post("/api/images/jobs", headers=session_headers, json={})
        assert r.status_code in (400, 422)

    def test_accepts_resolution_toggle_fields(self, client: httpx.Client, session_headers: dict):
        # The new `data_preparation` + `rescale` fields must deserialize; the request then
        # proceeds past auth/parsing toward storage/MQ (env-dependent), never 401/422.
        r = client.post("/api/images/jobs", headers=session_headers, json=self._BODY)
        assert r.status_code not in (401, 422)
