"""Tests for POST /api/files/cleanup."""

import io

import httpx
import pytest

from .helpers import auth_headers


def _tiny_png() -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
        b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f"
        b"\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
    )


@pytest.fixture()
def uploaded_image(client: httpx.Client, session_headers: dict) -> str:
    files = {"file": ("test.png", io.BytesIO(_tiny_png()), "image/png")}
    r = client.post(
        "/api/images/upload",
        headers={k: v for k, v in session_headers.items() if k.lower() != "content-type"},
        files=files,
    )
    if r.status_code in (400, 503):
        pytest.skip(f"image upload unavailable: {r.status_code} {r.text}")
    assert r.status_code == 201, r.text
    return r.json()["image_id"]


class TestFilesCleanup:
    def test_cleanup_uploads_keeps_starred(
        self, client: httpx.Client, session_headers: dict, uploaded_image: str
    ):
        star = client.patch(
            f"/api/images/files/{uploaded_image}/starred",
            headers=session_headers,
            json={"starred": True},
        )
        assert star.status_code == 200

        cleanup = client.post(
            "/api/files/cleanup",
            headers=session_headers,
            json={"scope": "uploads", "keep_starred": True},
        )
        assert cleanup.status_code == 200, cleanup.text
        body = cleanup.json()
        assert body["deleted_count"] == 0
        assert body["skipped_starred"] == 1

        listed = client.get("/api/files", headers=session_headers)
        assert listed.status_code == 200
        ids = {f["id"] for f in listed.json()["files"]}
        assert uploaded_image in ids

    def test_cleanup_uploads_deletes_unstarred(
        self, client: httpx.Client, session_headers: dict, uploaded_image: str
    ):
        cleanup = client.post(
            "/api/files/cleanup",
            headers=session_headers,
            json={"scope": "uploads", "keep_starred": True},
        )
        assert cleanup.status_code == 200, cleanup.text
        assert cleanup.json()["deleted_count"] >= 1

        listed = client.get("/api/files", headers=session_headers)
        ids = {f["id"] for f in listed.json()["files"]}
        assert uploaded_image not in ids

    def test_cleanup_invalid_scope(
        self, client: httpx.Client, session_headers: dict
    ):
        r = client.post(
            "/api/files/cleanup",
            headers=session_headers,
            json={"scope": "nope", "keep_starred": True},
        )
        assert r.status_code == 400
