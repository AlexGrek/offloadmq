"""Tests for GET /api/wiki/random (random Wikipedia article for the txt2img wiki drawer).

Hits the real Wikipedia API, like the rest of the suite hits real services; a network
outage surfaces as 502 and skips the live-content tests instead of failing them.
"""

import httpx
import pytest


class TestWikiRandom:
    def test_requires_auth(self, fresh_client: httpx.Client):
        assert fresh_client.get("/api/wiki/random").status_code == 401

    def test_rejects_bad_language(self, client: httpx.Client, new_user: dict):
        for bad in ("evil.com%2Fx", "e", "en.", "toolonglang"):
            r = client.get(f"/api/wiki/random?lang={bad}", headers=new_user["headers"])
            assert r.status_code == 400, bad

    def test_returns_article(self, client: httpx.Client, new_user: dict):
        r = client.get("/api/wiki/random", headers=new_user["headers"], timeout=30)
        if r.status_code == 502:
            pytest.skip("Wikipedia unreachable from the backend")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["title"]
        assert body["extract"]
        assert body["url"].startswith("https://en.wikipedia.org/")
        assert body["lang"] == "en"

    def test_other_language_edition(self, client: httpx.Client, new_user: dict):
        r = client.get("/api/wiki/random?lang=uk", headers=new_user["headers"], timeout=30)
        if r.status_code == 502:
            pytest.skip("Wikipedia unreachable from the backend")
        assert r.status_code == 200, r.text
        assert r.json()["url"].startswith("https://uk.wikipedia.org/")
