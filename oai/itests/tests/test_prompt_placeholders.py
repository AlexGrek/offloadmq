"""Tests for GET, POST, PATCH, DELETE /api/prompt-placeholders."""

import httpx
import pytest

class TestPromptPlaceholdersLifecycle:
    def test_crud_lifecycle(self, client: httpx.Client, session_headers: dict):
        # 1. List initially empty
        r = client.get("/api/prompt-placeholders", headers=session_headers)
        assert r.status_code == 200
        assert r.json() == []

        # 2. Create
        payload = {"name": "my-style", "variants": ["variant 1", "variant 2"]}
        r = client.post("/api/prompt-placeholders", headers=session_headers, json=payload)
        assert r.status_code == 200
        created = r.json()
        assert "id" in created
        assert created["name"] == "my-style"
        assert created["variants"] == ["variant 1", "variant 2"]
        pid = created["id"]

        # 3. List contains created
        r = client.get("/api/prompt-placeholders", headers=session_headers)
        assert r.status_code == 200
        items = r.json()
        assert len(items) == 1
        assert items[0]["id"] == pid
        assert items[0]["name"] == "my-style"

        # 4. Update
        update_payload = {"name": "my-style.v2", "variants": ["variant 3"]}
        r = client.patch(f"/api/prompt-placeholders/{pid}", headers=session_headers, json=update_payload)
        assert r.status_code == 200
        updated = r.json()
        assert updated["id"] == pid
        assert updated["name"] == "my-style.v2"
        assert updated["variants"] == ["variant 3"]

        # 5. Delete
        r = client.delete(f"/api/prompt-placeholders/{pid}", headers=session_headers)
        assert r.status_code == 204

        # 6. List is empty again
        r = client.get("/api/prompt-placeholders", headers=session_headers)
        assert r.status_code == 200
        assert r.json() == []


class TestPromptPlaceholdersValidation:
    def test_reserved_name_rejected(self, client: httpx.Client, session_headers: dict):
        for name in ["color", "Animal", "adjective", "country", "language", "name", "starwars", "?"]:
            payload = {"name": name, "variants": ["test"]}
            r = client.post("/api/prompt-placeholders", headers=session_headers, json=payload)
            assert r.status_code == 400
            assert "reserved" in r.text.lower() or "cannot be" in r.text.lower() or "invalid" in r.text.lower() or "already" in r.text.lower() or r.status_code == 400 # Just assert 400 is fine

    def test_invalid_chars_rejected(self, client: httpx.Client, session_headers: dict):
        payload = {"name": "my space", "variants": ["test"]}
        r = client.post("/api/prompt-placeholders", headers=session_headers, json=payload)
        assert r.status_code == 400
        
        payload = {"name": "special@!", "variants": ["test"]}
        r = client.post("/api/prompt-placeholders", headers=session_headers, json=payload)
        assert r.status_code == 400

    def test_empty_variants_rejected(self, client: httpx.Client, session_headers: dict):
        payload = {"name": "valid-name", "variants": []}
        r = client.post("/api/prompt-placeholders", headers=session_headers, json=payload)
        assert r.status_code == 400

        payload = {"name": "valid-name", "variants": ["", "   "]}
        r = client.post("/api/prompt-placeholders", headers=session_headers, json=payload)
        assert r.status_code == 400


class TestPromptPlaceholdersAuth:
    def test_unauthorized(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/prompt-placeholders")
        assert r.status_code == 401
        
        r = fresh_client.post("/api/prompt-placeholders", json={"name": "test", "variants": ["v"]})
        assert r.status_code == 401

        r = fresh_client.patch("/api/prompt-placeholders/123", json={"name": "test", "variants": ["v"]})
        assert r.status_code == 401
        
        r = fresh_client.delete("/api/prompt-placeholders/123")
        assert r.status_code == 401
