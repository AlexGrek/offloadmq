"""Tests for Personas: /api/personas/*, /api/persona-photos/*, persona chats
(/api/chats?kind=persona) and the REST chat send/poll endpoints.

Generation and chat replies need online agents, so these cover CRUD, validation,
persona chat scoping, and the up-front 400s of the photo start; the MCP persona
tools are exercised in test_mcp.py.
"""

import io
import uuid

import httpx
import pytest

from .helpers import auth_headers


def _tiny_png() -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
        b"\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f"
        b"\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def upload(client: httpx.Client, headers: dict) -> str:
    files = {"file": ("face.png", io.BytesIO(_tiny_png()), "image/png")}
    r = client.post(
        "/api/images/upload",
        headers={k: v for k, v in headers.items() if k.lower() != "content-type"},
        files=files,
    )
    if r.status_code in (400, 503):
        pytest.skip(f"image upload unavailable: {r.status_code} {r.text}")
    assert r.status_code == 201, r.text
    return r.json()["image_id"]


def create(client: httpx.Client, headers: dict, **fields) -> dict:
    body = {"name": f"P {uuid.uuid4().hex[:8]}", **fields}
    r = client.post("/api/personas", headers=headers, json=body)
    assert r.status_code == 201, r.text
    return r.json()


class TestPersonaCrud:
    def test_lifecycle(self, client: httpx.Client, new_user: dict):
        h = new_user["headers"]
        face = upload(client, h)
        p = create(
            client,
            h,
            system_prompt="You are {p_name}. You look like {p_look}.",
            look="short silver hair",
            face_image_ids=[face],
            llm_capability="llm.qwen3:8b[vision]",
            txt2img_capability="auto",
        )
        assert p["face_image_ids"] == [face]
        assert p["faces"][0]["image_id"] == face
        assert p["llm_capability"] == "llm.qwen3:8b"  # brackets stripped
        assert p["txt2img_capability"] is None  # "auto" = no preference
        assert p["rendered_system_prompt"] == f"You are {p['name']}. You look like short silver hair."

        listed = client.get("/api/personas", headers=h).json()
        assert [x["id"] for x in listed] == [p["id"]]
        assert "effective" not in listed[0]

        detail = client.get(f"/api/personas/{p['id']}", headers=h)
        assert detail.status_code == 200, detail.text
        assert "effective" in detail.json()  # best-effort, errors listed without OffloadMQ

        upd = dict(p, name="Renamed", look="long red hair", face_image_ids=[])
        r = client.put(f"/api/personas/{p['id']}", headers=h, json=upd)
        assert r.status_code == 200, r.text
        assert r.json()["name"] == "Renamed"
        assert r.json()["faces"] == []

        assert client.delete(f"/api/personas/{p['id']}", headers=h).status_code == 204
        assert client.get(f"/api/personas/{p['id']}", headers=h).status_code == 404

    def test_validation(self, client: httpx.Client, new_user: dict):
        h = new_user["headers"]
        assert client.post("/api/personas", headers=h, json={"name": "  "}).status_code == 400
        assert (
            client.post("/api/personas", headers=h, json={"name": "x", "llm_capability": "imggen.flux"}).status_code
            == 400
        )
        assert (
            client.post("/api/personas", headers=h, json={"name": "x", "face_image_ids": ["123"]}).status_code
            == 400
        )
        p = create(client, h)
        dup = client.post("/api/personas", headers=h, json={"name": p["name"].upper()})
        assert dup.status_code == 400

    def test_personas_are_private(self, client: httpx.Client, new_user: dict, session_headers: dict):
        p = create(client, new_user["headers"])
        assert client.get(f"/api/personas/{p['id']}", headers=session_headers).status_code == 404
        # Someone else's upload can't become a face.
        other_face = upload(client, session_headers)
        r = client.put(
            f"/api/personas/{p['id']}",
            headers=new_user["headers"],
            json={"name": p["name"], "face_image_ids": [other_face]},
        )
        assert r.status_code == 400

    def test_options_endpoint_shape(self, client: httpx.Client, new_user: dict):
        r = client.get("/api/personas/options", headers=new_user["headers"])
        assert r.status_code == 200, r.text
        body = r.json()
        for key in ("llm", "txt2img", "img2img", "face_swap", "upscaler", "errors"):
            assert key in body

    def test_persona_tokens_are_reserved_placeholder_names(self, client: httpx.Client, new_user: dict):
        for name in ("p_look", "P_NAME", "p_system"):
            r = client.post(
                "/api/prompt-placeholders",
                headers=new_user["headers"],
                json={"name": name, "variants": ["x"]},
            )
            assert r.status_code == 400, name


class TestPersonaChats:
    def test_persona_chats_are_scoped(self, client: httpx.Client, new_user: dict):
        h = new_user["headers"]
        a = create(client, h, system_prompt="I am {p_name}.")
        b = create(client, h)
        r = client.post("/api/chats", headers=h, json={"kind": "persona", "persona_id": a["id"]})
        assert r.status_code == 201, r.text
        chat = r.json()
        assert chat["kind"] == "persona"
        assert chat["persona_id"] == a["id"]
        assert chat["system_prompt"] == f"I am {a['name']}."

        mine = client.get("/api/chats", headers=h, params={"kind": "persona", "persona_id": a["id"]}).json()
        assert [c["id"] for c in mine] == [chat["id"]]
        theirs = client.get("/api/chats", headers=h, params={"kind": "persona", "persona_id": b["id"]}).json()
        assert theirs == []
        plain = client.get("/api/chats", headers=h).json()
        assert chat["id"] not in [c["id"] for c in plain]

        # The persona owns the system prompt.
        r = client.patch(f"/api/chats/{chat['id']}/system-prompt", headers=h, json={"content": "x"})
        assert r.status_code == 400

        # Deleting the persona deletes its chats.
        assert client.delete(f"/api/personas/{a['id']}", headers=h).status_code == 204
        assert client.get(f"/api/chats/{chat['id']}/messages", headers=h).status_code == 404

    def test_create_validation(self, client: httpx.Client, new_user: dict):
        h = new_user["headers"]
        assert client.post("/api/chats", headers=h, json={"kind": "persona"}).status_code == 400
        p = create(client, h)
        assert client.post("/api/chats", headers=h, json={"kind": "chat", "persona_id": p["id"]}).status_code == 400
        assert (
            client.post("/api/chats", headers=h, json={"kind": "persona", "persona_id": "999"}).status_code == 404
        )

    def test_rest_send_validation(self, client: httpx.Client, new_user: dict):
        h = new_user["headers"]
        chat = client.post("/api/chats", headers=h, json={}).json()
        # No capability and no last model on a plain chat.
        r = client.post(f"/api/chats/{chat['id']}/messages", headers=h, json={"content": "hi"})
        assert r.status_code == 400, r.text
        r = client.post(
            f"/api/chats/{chat['id']}/messages", headers=h, json={"content": "  ", "capability": "llm.x"}
        )
        assert r.status_code == 400
        r = client.post(
            f"/api/chats/{chat['id']}/messages", headers=h, json={"content": "hi", "capability": "imggen.x"}
        )
        assert r.status_code == 400
        assert client.get(f"/api/chats/{chat['id']}/messages/1", headers=h).status_code == 404


class TestPersonaPhotos:
    def test_start_validation(self, client: httpx.Client, new_user: dict):
        h = new_user["headers"]
        p = create(client, h)
        url = f"/api/personas/{p['id']}/photos"
        assert client.post(url, headers=h, json={"prompt": " "}).status_code == 400
        assert client.post(url, headers=h, json={"prompt": "x", "count": 9}).status_code == 400
        assert client.post(url, headers=h, json={"prompt": "x", "workflow": "img2img"}).status_code == 400
        assert client.post(url, headers=h, json={"prompt": "x", "workflow": "video"}).status_code == 400
        assert client.post(url, headers=h, json={"prompt": "x", "width": 10}).status_code == 400
        # No faces + explicit face swap.
        r = client.post(url, headers=h, json={"prompt": "x", "face_swap": True, "upscale": False})
        assert r.status_code == 400
        assert client.get(url, headers=h).json() == []

    def test_unknown_photo_and_foreign_persona(self, client: httpx.Client, new_user: dict, session_headers: dict):
        assert client.get("/api/persona-photos/123", headers=new_user["headers"]).status_code == 404
        p = create(client, new_user["headers"])
        r = client.post(f"/api/personas/{p['id']}/photos", headers=session_headers, json={"prompt": "x"})
        assert r.status_code == 404

    def test_requires_auth(self, fresh_client: httpx.Client):
        assert fresh_client.get("/api/personas").status_code == 401
        assert fresh_client.get("/api/persona-photos/1").status_code == 401
