"""Tests for /api/images/stash — stashed (deferred) image-generation requests.

Stashing, listing and deleting are pure DB operations. Starting an entry submits it
to OffloadMQ, which these tests don't have, so only the failure contract is
asserted: a start that cannot submit leaves the entry in the stash.
"""

import httpx

MISSING_ID = "999999999999999999"


def _txt2img(**overrides) -> dict:
    body = {
        "capability": "imggen.test-model",
        "prompt": "a {color} {animal} on the moon",
        "prompt_template": "a {color} {animal} on the moon",
        "width": 512,
        "height": 512,
        "workflow": "txt2img",
    }
    body.update(overrides)
    return body


def _list(client: httpx.Client, headers: dict) -> list[dict]:
    r = client.get("/api/images/stash", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


class TestStashCrud:
    def test_new_user_has_empty_stash(self, client: httpx.Client, new_user: dict):
        assert _list(client, new_user["headers"]) == []

    def test_stash_list_delete_round_trip(self, client: httpx.Client, new_user: dict):
        h = new_user["headers"]
        r = client.post("/api/images/stash", headers=h, json=_txt2img())
        assert r.status_code == 201, r.text
        entry = r.json()
        assert entry["id"]
        assert entry["created_at"]
        # Stored verbatim — the prompt stays unexpanded until the entry is started.
        assert entry["request"]["prompt"] == "a {color} {animal} on the moon"
        assert entry["request"]["capability"] == "imggen.test-model"

        second = client.post("/api/images/stash", headers=h, json=_txt2img(prompt="second"))
        assert second.status_code == 201

        listed = _list(client, h)
        assert [e["id"] for e in listed] == [second.json()["id"], entry["id"]], "newest first"

        r = client.delete(f"/api/images/stash/{entry['id']}", headers=h)
        assert r.status_code == 204
        assert [e["id"] for e in _list(client, h)] == [second.json()["id"]]

        r = client.delete(f"/api/images/stash/{entry['id']}", headers=h)
        assert r.status_code == 404

    def test_entries_are_private(self, client: httpx.Client, new_user: dict, session_headers: dict):
        r = client.post("/api/images/stash", headers=new_user["headers"], json=_txt2img())
        assert r.status_code == 201
        entry_id = r.json()["id"]

        assert entry_id not in [e["id"] for e in _list(client, session_headers)]
        assert client.delete(f"/api/images/stash/{entry_id}", headers=session_headers).status_code == 404
        assert client.post(f"/api/images/stash/{entry_id}/start", headers=session_headers).status_code == 404
        assert [e["id"] for e in _list(client, new_user["headers"])] == [entry_id]


class TestStashValidation:
    def test_rejects_non_imggen_capability(self, client: httpx.Client, new_user: dict):
        r = client.post("/api/images/stash", headers=new_user["headers"], json=_txt2img(capability="llm.x"))
        assert r.status_code == 400

    def test_rejects_empty_prompt(self, client: httpx.Client, new_user: dict):
        r = client.post("/api/images/stash", headers=new_user["headers"], json=_txt2img(prompt="  "))
        assert r.status_code == 400

    def test_rejects_malformed_request(self, client: httpx.Client, new_user: dict):
        r = client.post("/api/images/stash", headers=new_user["headers"], json={"prompt": "x"})
        assert r.status_code == 400

    def test_img2img_requires_input(self, client: httpx.Client, new_user: dict):
        r = client.post("/api/images/stash", headers=new_user["headers"], json=_txt2img(workflow="img2img"))
        assert r.status_code == 400

    def test_input_image_must_be_owned(self, client: httpx.Client, new_user: dict):
        r = client.post(
            "/api/images/stash",
            headers=new_user["headers"],
            json=_txt2img(workflow="img2img", input_image_id=MISSING_ID),
        )
        assert r.status_code == 404

    def test_high_priority_is_admin_only(self, client: httpx.Client, new_user: dict):
        r = client.post("/api/images/stash", headers=new_user["headers"], json=_txt2img(high_priority=True))
        assert r.status_code == 403
        assert _list(client, new_user["headers"]) == []


class TestStashStart:
    def test_missing_entry_returns_404(self, client: httpx.Client, new_user: dict):
        r = client.post(f"/api/images/stash/{MISSING_ID}/start", headers=new_user["headers"])
        assert r.status_code == 404

    def test_invalid_id_returns_400(self, client: httpx.Client, new_user: dict):
        r = client.post("/api/images/stash/nope/start", headers=new_user["headers"])
        assert r.status_code == 400

    def test_failed_start_keeps_entry(self, client: httpx.Client, new_user: dict):
        """No OffloadMQ in the test stack, so the submit fails — the entry must survive."""
        h = new_user["headers"]
        entry = client.post("/api/images/stash", headers=h, json=_txt2img()).json()
        r = client.post(f"/api/images/stash/{entry['id']}/start", headers=h)
        if r.status_code == 201:
            # A stack that does have OffloadMQ configured: the entry is consumed.
            assert _list(client, h) == []
            return
        assert r.status_code >= 400
        listed = _list(client, h)
        assert [e["id"] for e in listed] == [entry["id"]]
        assert listed[0]["created_at"] == entry["created_at"]


class TestStashAuth:
    def test_requires_token(self, fresh_client: httpx.Client):
        assert fresh_client.get("/api/images/stash").status_code == 401
        assert fresh_client.post("/api/images/stash", json=_txt2img()).status_code == 401
        assert fresh_client.delete(f"/api/images/stash/{MISSING_ID}").status_code == 401
        assert fresh_client.post(f"/api/images/stash/{MISSING_ID}/start").status_code == 401
