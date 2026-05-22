"""Tests for /api/images/files/{id} star and delete endpoints."""

import io

import httpx
import pytest

from .helpers import auth_headers


def _tiny_png() -> bytes:
    # 1×1 PNG
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
        b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f"
        b"\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
    )


@pytest.fixture()
def uploaded_image(client: httpx.Client, session_headers: dict) -> str:
    """Upload a minimal input image; returns image_id string."""
    files = {"file": ("test.png", io.BytesIO(_tiny_png()), "image/png")}
    r = client.post(
        "/api/images/upload",
        headers={k: v for k, v in session_headers.items() if k.lower() != "content-type"},
        files=files,
    )
    if r.status_code == 503 or r.status_code == 400:
        pytest.skip(f"image upload unavailable: {r.status_code} {r.text}")
    assert r.status_code == 201, r.text
    return r.json()["image_id"]


class TestImageStarred:
    def test_get_starred_false_for_new_upload(
        self, client: httpx.Client, session_headers: dict, uploaded_image: str
    ):
        r = client.get(
            f"/api/images/files/{uploaded_image}/starred",
            headers=session_headers,
        )
        assert r.status_code == 200
        assert r.json()["starred"] is False

    def test_star_and_unstar(
        self, client: httpx.Client, session_headers: dict, uploaded_image: str
    ):
        star = client.patch(
            f"/api/images/files/{uploaded_image}/starred",
            headers=session_headers,
            json={"starred": True},
        )
        assert star.status_code == 200
        assert star.json()["starred"] is True

        check = client.get(
            f"/api/images/files/{uploaded_image}/starred",
            headers=session_headers,
        )
        assert check.json()["starred"] is True

        unstar = client.patch(
            f"/api/images/files/{uploaded_image}/starred",
            headers=session_headers,
            json={"starred": False},
        )
        assert unstar.status_code == 200
        assert unstar.json()["starred"] is False

    def test_delete_rejects_input_upload(
        self, client: httpx.Client, session_headers: dict, uploaded_image: str
    ):
        r = client.delete(
            f"/api/images/files/{uploaded_image}",
            headers=session_headers,
        )
        assert r.status_code == 400
        assert "output" in r.json()["error"].lower()

    def test_starred_requires_auth(self, fresh_client: httpx.Client, uploaded_image: str):
        r = fresh_client.get(f"/api/images/files/{uploaded_image}/starred")
        assert r.status_code == 401
