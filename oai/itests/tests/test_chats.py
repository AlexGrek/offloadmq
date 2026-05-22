"""Tests for GET/POST /api/chats and GET/DELETE /api/chats/{id}/messages."""

import httpx


class TestListChats:
    def test_returns_200(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/chats", headers=session_headers)
        assert r.status_code == 200

    def test_returns_list(self, client: httpx.Client, session_headers: dict):
        r = client.get("/api/chats", headers=session_headers)
        assert isinstance(r.json(), list)

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/chats")
        assert r.status_code == 401


class TestCreateChat:
    def test_returns_201(self, client: httpx.Client, new_user: dict):
        r = client.post("/api/chats", headers=new_user["headers"])
        assert r.status_code == 201

    def test_response_has_id(self, client: httpx.Client, new_user: dict):
        r = client.post("/api/chats", headers=new_user["headers"])
        body = r.json()
        assert "id" in body
        assert isinstance(body["id"], str)
        assert body["id"]

    def test_response_has_timestamps(self, client: httpx.Client, new_user: dict):
        r = client.post("/api/chats", headers=new_user["headers"])
        body = r.json()
        assert "created_at" in body
        assert "updated_at" in body

    def test_appears_in_list(self, client: httpx.Client, new_user: dict):
        create_r = client.post("/api/chats", headers=new_user["headers"])
        chat_id = create_r.json()["id"]

        list_r = client.get("/api/chats", headers=new_user["headers"])
        ids = [c["id"] for c in list_r.json()]
        assert chat_id in ids

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.post("/api/chats")
        assert r.status_code == 401

    def test_user_isolation(self, client: httpx.Client, new_user: dict):
        """Chats created by one user are not visible to another."""
        other_body = client.post(
            "/api/auth/register",
            json={"login": f"iso_{new_user['login']}", "password": "testpass123"},
        ).json()
        other_headers = {"Authorization": f"Bearer {other_body['token']}"}

        chat_id = client.post("/api/chats", headers=new_user["headers"]).json()["id"]

        other_list = client.get("/api/chats", headers=other_headers).json()
        ids = [c["id"] for c in other_list]
        assert chat_id not in ids


class TestDeleteChat:
    def test_returns_204(self, client: httpx.Client, new_user: dict):
        chat_id = client.post("/api/chats", headers=new_user["headers"]).json()["id"]
        r = client.delete(f"/api/chats/{chat_id}", headers=new_user["headers"])
        assert r.status_code == 204

    def test_removed_from_list(self, client: httpx.Client, new_user: dict):
        chat_id = client.post("/api/chats", headers=new_user["headers"]).json()["id"]
        client.delete(f"/api/chats/{chat_id}", headers=new_user["headers"])

        ids = [c["id"] for c in client.get("/api/chats", headers=new_user["headers"]).json()]
        assert chat_id not in ids

    def test_no_token_returns_401(self, client: httpx.Client, new_user: dict):
        chat_id = client.post("/api/chats", headers=new_user["headers"]).json()["id"]
        r = client.delete(f"/api/chats/{chat_id}")
        assert r.status_code == 401

    def test_invalid_id_returns_400(self, client: httpx.Client, new_user: dict):
        r = client.delete("/api/chats/not_a_number", headers=new_user["headers"])
        assert r.status_code == 400

    def test_other_user_cannot_delete(self, client: httpx.Client, new_user: dict):
        """Deleting another user's chat returns 404 (ownership enforced)."""
        other = client.post(
            "/api/auth/register",
            json={"login": f"del_{new_user['login']}", "password": "testpass123"},
        ).json()
        other_headers = {"Authorization": f"Bearer {other['token']}"}

        chat_id = client.post("/api/chats", headers=new_user["headers"]).json()["id"]
        r = client.delete(f"/api/chats/{chat_id}", headers=other_headers)
        assert r.status_code == 404


class TestGetMessages:
    def test_returns_200(self, client: httpx.Client, new_user: dict):
        chat_id = client.post("/api/chats", headers=new_user["headers"]).json()["id"]
        r = client.get(f"/api/chats/{chat_id}/messages", headers=new_user["headers"])
        assert r.status_code == 200

    def test_returns_empty_list_for_new_chat(self, client: httpx.Client, new_user: dict):
        chat_id = client.post("/api/chats", headers=new_user["headers"]).json()["id"]
        msgs = client.get(f"/api/chats/{chat_id}/messages", headers=new_user["headers"]).json()
        assert msgs == []

    def test_no_token_returns_401(self, client: httpx.Client, new_user: dict):
        chat_id = client.post("/api/chats", headers=new_user["headers"]).json()["id"]
        r = client.get(f"/api/chats/{chat_id}/messages")
        assert r.status_code == 401

    def test_invalid_id_returns_400(self, client: httpx.Client, new_user: dict):
        r = client.get("/api/chats/not_a_number/messages", headers=new_user["headers"])
        assert r.status_code == 400

    def test_other_user_cannot_read_messages(self, client: httpx.Client, new_user: dict):
        """Fetching messages for another user's chat returns 404."""
        other = client.post(
            "/api/auth/register",
            json={"login": f"msg_{new_user['login']}", "password": "testpass123"},
        ).json()
        other_headers = {"Authorization": f"Bearer {other['token']}"}

        chat_id = client.post("/api/chats", headers=new_user["headers"]).json()["id"]
        r = client.get(f"/api/chats/{chat_id}/messages", headers=other_headers)
        assert r.status_code == 404
