"""Tests for POST /api/prompts/{bucket}/recent and GET /api/prompts/{bucket}.

Covers the "recent" recording endpoint used to decouple prompt-history
bookkeeping from image job submission: recording must be an explicit,
caller-controlled action (one call = one recent entry, deduped by content),
and submitting an image job must never record a recent entry as a side
effect any more (a "generate multiple" batch calls the job endpoint N times
for one user action, so if job submission still recorded recents, the
history would fill with per-job placeholder variants instead of the single
template the user typed).
"""

import uuid

import httpx


class TestRecordRecent:
    def test_returns_200_with_content(self, client: httpx.Client, new_user: dict):
        r = client.post(
            "/api/prompts/imggen-prompt/recent",
            headers=new_user["headers"],
            json={"content": "a cat wearing a hat"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["content"] == "a cat wearing a hat"
        assert isinstance(body["id"], str) and body["id"]

    def test_appears_in_recent_list(self, client: httpx.Client, new_user: dict):
        content = f"nonce-{uuid.uuid4().hex[:8]} a dog on a skateboard"
        client.post(
            "/api/prompts/imggen-prompt/recent",
            headers=new_user["headers"],
            json={"content": content},
        )
        library = client.get("/api/prompts/imggen-prompt", headers=new_user["headers"]).json()
        assert content in [item["content"] for item in library["recent"]]

    def test_repeated_content_does_not_duplicate(self, client: httpx.Client, new_user: dict):
        """Recording the same content twice bumps it, but the recent list keeps one entry."""
        content = f"nonce-{uuid.uuid4().hex[:8]} a robot in a forest"
        for _ in range(3):
            r = client.post(
                "/api/prompts/imggen-prompt/recent",
                headers=new_user["headers"],
                json={"content": content},
            )
            assert r.status_code == 200

        library = client.get("/api/prompts/imggen-prompt", headers=new_user["headers"]).json()
        matches = [item["content"] for item in library["recent"] if item["content"] == content]
        assert matches == [content]

    def test_distinct_content_creates_distinct_entries(self, client: httpx.Client, new_user: dict):
        """Two different (already-expanded) strings are still two separate recents —
        deliberately calling record twice for two batch jobs is still the caller's choice."""
        nonce = uuid.uuid4().hex[:8]
        first = f"a red fox in the snow {nonce}"
        second = f"a blue fox in the snow {nonce}"
        client.post(
            "/api/prompts/imggen-prompt/recent", headers=new_user["headers"], json={"content": first}
        )
        client.post(
            "/api/prompts/imggen-prompt/recent", headers=new_user["headers"], json={"content": second}
        )
        recent = [
            item["content"]
            for item in client.get("/api/prompts/imggen-prompt", headers=new_user["headers"]).json()[
                "recent"
            ]
        ]
        assert first in recent
        assert second in recent

    def test_empty_content_returns_400(self, client: httpx.Client, new_user: dict):
        r = client.post(
            "/api/prompts/imggen-prompt/recent", headers=new_user["headers"], json={"content": "   "}
        )
        assert r.status_code == 400
        assert isinstance(r.json()["error"], str)

    def test_no_token_returns_401(self, fresh_client: httpx.Client):
        r = fresh_client.post("/api/prompts/imggen-prompt/recent", json={"content": "anything"})
        assert r.status_code == 401

    def test_user_isolation(self, client: httpx.Client, new_user: dict):
        """A recent recorded by one user is not visible to another user in the same bucket."""
        content = f"nonce-{uuid.uuid4().hex[:8]} isolated prompt"
        client.post(
            "/api/prompts/imggen-prompt/recent", headers=new_user["headers"], json={"content": content}
        )

        other = client.post(
            "/api/auth/register",
            json={"login": f"iso_{new_user['login']}", "password": "testpass123"},
        ).json()
        other_headers = {"Authorization": f"Bearer {other['token']}"}

        recent = [
            item["content"]
            for item in client.get("/api/prompts/imggen-prompt", headers=other_headers).json()["recent"]
        ]
        assert content not in recent


class TestImageJobDoesNotAutoRecordPrompt:
    def test_submitting_job_does_not_record_recent(self, client: httpx.Client, new_user: dict):
        """Regression test: POST /api/images/jobs used to record the (already-
        expanded) prompt as a recent as a side effect. It must not any more —
        recording is now solely the frontend's explicit, once-per-submission
        call to POST /api/prompts/{bucket}/recent. This holds regardless of
        whether the job submission itself succeeds (e.g. no OffloadMQ agent
        online in the test environment): the old recording ran unconditionally
        before the job was even created downstream."""
        nonce_prompt = f"nonce-{uuid.uuid4().hex[:8]} a job-submission side effect probe"
        client.post(
            "/api/images/jobs",
            headers=new_user["headers"],
            json={
                "capability": "imggen.txt2img",
                "prompt": nonce_prompt,
                "negative_prompt": None,
                "override_negative": False,
                "width": 512,
                "height": 512,
                "seed": None,
                "workflow": "txt2img",
                "input_image_id": None,
                "data_preparation": None,
            },
        )

        recent = [
            item["content"]
            for item in client.get("/api/prompts/imggen-prompt", headers=new_user["headers"]).json()[
                "recent"
            ]
        ]
        assert nonce_prompt not in recent

    def test_generate_multiple_style_batch_records_once_via_explicit_call(
        self, client: httpx.Client, new_user: dict
    ):
        """Simulates the frontend's "generate multiple" flow: the raw template
        is recorded once (frontend does this before the loop), while N job
        submissions each carry a different expanded variant of that template
        and must not add their own recents."""
        nonce = uuid.uuid4().hex[:8]
        template = f"a {{color}} fox in the snow {nonce}"

        client.post(
            "/api/prompts/imggen-prompt/recent",
            headers=new_user["headers"],
            json={"content": template},
        )
        expanded_variants = [f"a red fox in the snow {nonce}", f"a blue fox in the snow {nonce}"]
        for variant in expanded_variants:
            client.post(
                "/api/images/jobs",
                headers=new_user["headers"],
                json={
                    "capability": "imggen.txt2img",
                    "prompt": variant,
                    "negative_prompt": None,
                    "override_negative": False,
                    "width": 512,
                    "height": 512,
                    "seed": None,
                    "workflow": "txt2img",
                    "input_image_id": None,
                    "data_preparation": None,
                },
            )

        recent = [
            item["content"]
            for item in client.get("/api/prompts/imggen-prompt", headers=new_user["headers"]).json()[
                "recent"
            ]
        ]
        assert template in recent
        for variant in expanded_variants:
            assert variant not in recent


# ---------------------------------------------------------------------------
# Paged library listing (GET /api/prompts/{bucket}/entries) + previews
# ---------------------------------------------------------------------------


def _star(client: httpx.Client, headers: dict, bucket: str, content: str) -> dict:
    r = client.post(f"/api/prompts/{bucket}/star", headers=headers, json={"content": content})
    assert r.status_code == 200, r.text
    return r.json()


def _entries(client: httpx.Client, headers: dict, bucket: str, **params) -> httpx.Response:
    return client.get(f"/api/prompts/{bucket}/entries", headers=headers, params=params)


class TestPromptEntriesPaging:
    def test_pages_cover_all_favorites_without_overlap(self, client: httpx.Client, new_user: dict):
        bucket = f"it-paging-{uuid.uuid4().hex[:6]}"
        contents = [f"favorite number {i:02d}" for i in range(45)]
        for c in contents:
            _star(client, new_user["headers"], bucket, c)

        first = _entries(client, new_user["headers"], bucket, kind="starred", limit=40)
        assert first.status_code == 200, first.text
        page1 = first.json()
        assert len(page1["items"]) == 40
        assert page1["next_cursor"]

        second = _entries(
            client, new_user["headers"], bucket, kind="starred", limit=40, cursor=page1["next_cursor"]
        ).json()
        assert len(second["items"]) == 5
        assert second["next_cursor"] is None

        ids = [i["id"] for i in page1["items"] + second["items"]]
        assert len(set(ids)) == 45
        seen = {i["content"] for i in page1["items"] + second["items"]}
        assert seen == set(contents)
        # Newest favorite first.
        assert page1["items"][0]["content"] == contents[-1]

    def test_entry_shape(self, client: httpx.Client, new_user: dict):
        bucket = f"it-shape-{uuid.uuid4().hex[:6]}"
        _star(client, new_user["headers"], bucket, "shape probe")
        item = _entries(client, new_user["headers"], bucket, kind="starred").json()["items"][0]
        assert item["kind"] == "starred"
        assert item["content"] == "shape probe"
        assert item["preview_version"] is None
        for field in ("id", "created_at", "last_used_at", "updated_at"):
            assert item[field]

    def test_recent_kind_lists_recents_only(self, client: httpx.Client, new_user: dict):
        bucket = f"it-kind-{uuid.uuid4().hex[:6]}"
        client.post(f"/api/prompts/{bucket}/recent", headers=new_user["headers"], json={"content": "a recent"})
        _star(client, new_user["headers"], bucket, "a favorite")
        items = _entries(client, new_user["headers"], bucket, kind="recent").json()["items"]
        assert [i["content"] for i in items] == ["a recent"]
        assert items[0]["kind"] == "recent"

    def test_invalid_kind_is_400(self, client: httpx.Client, new_user: dict):
        r = _entries(client, new_user["headers"], "imggen-prompt", kind="everything")
        assert r.status_code == 400

    def test_invalid_cursor_is_400(self, client: httpx.Client, new_user: dict):
        r = _entries(client, new_user["headers"], "imggen-prompt", kind="starred", cursor="nope")
        assert r.status_code == 400

    def test_requires_auth(self, fresh_client: httpx.Client):
        r = fresh_client.get("/api/prompts/imggen-prompt/entries", params={"kind": "recent"})
        assert r.status_code == 401

    def test_other_users_entries_are_invisible(self, client: httpx.Client, new_user: dict, session_headers: dict):
        bucket = f"it-iso-{uuid.uuid4().hex[:6]}"
        _star(client, new_user["headers"], bucket, "private favorite")
        items = _entries(client, session_headers, bucket, kind="starred").json()["items"]
        assert items == []


class TestPromptEntriesSearch:
    def test_case_insensitive_substring(self, client: httpx.Client, new_user: dict):
        bucket = f"it-search-{uuid.uuid4().hex[:6]}"
        for c in ("A Red Fox at dawn", "blue whale", "fox terrier portrait"):
            _star(client, new_user["headers"], bucket, c)
        items = _entries(client, new_user["headers"], bucket, kind="starred", q="FOX").json()["items"]
        assert {i["content"] for i in items} == {"A Red Fox at dawn", "fox terrier portrait"}

    def test_wildcards_are_literal(self, client: httpx.Client, new_user: dict):
        bucket = f"it-wild-{uuid.uuid4().hex[:6]}"
        for c in ("100% cotton", "1000 cotton", "snake_case", "snakeXcase"):
            _star(client, new_user["headers"], bucket, c)
        pct = _entries(client, new_user["headers"], bucket, kind="starred", q="0%").json()["items"]
        assert [i["content"] for i in pct] == ["100% cotton"]
        under = _entries(client, new_user["headers"], bucket, kind="starred", q="e_c").json()["items"]
        assert [i["content"] for i in under] == ["snake_case"]

    def test_search_pages(self, client: httpx.Client, new_user: dict):
        bucket = f"it-spage-{uuid.uuid4().hex[:6]}"
        for i in range(7):
            _star(client, new_user["headers"], bucket, f"match {i}")
            _star(client, new_user["headers"], bucket, f"other {i}")
        page1 = _entries(client, new_user["headers"], bucket, kind="starred", q="match", limit=5).json()
        page2 = _entries(
            client, new_user["headers"], bucket, kind="starred", q="match", limit=5, cursor=page1["next_cursor"]
        ).json()
        got = [i["content"] for i in page1["items"] + page2["items"]]
        assert sorted(got) == [f"match {i}" for i in range(7)]
        assert page2["next_cursor"] is None


class TestPromptPreviewAndEdit:
    def test_preview_404_without_image(self, client: httpx.Client, new_user: dict):
        bucket = f"it-prev-{uuid.uuid4().hex[:6]}"
        entry = _star(client, new_user["headers"], bucket, "no image yet")
        r = client.get(f"/api/prompt-entries/{entry['id']}/preview", headers=new_user["headers"])
        assert r.status_code == 404

    def test_preview_of_other_users_entry_is_404(
        self, client: httpx.Client, new_user: dict, session_headers: dict
    ):
        entry = _star(client, new_user["headers"], f"it-prev-{uuid.uuid4().hex[:6]}", "mine")
        r = client.get(f"/api/prompt-entries/{entry['id']}/preview", headers=session_headers)
        assert r.status_code == 404

    def test_patch_returns_full_entry(self, client: httpx.Client, new_user: dict):
        bucket = f"it-edit-{uuid.uuid4().hex[:6]}"
        entry = _star(client, new_user["headers"], bucket, "before edit")
        r = client.patch(
            f"/api/prompt-entries/{entry['id']}", headers=new_user["headers"], json={"content": "after edit"}
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["id"] == entry["id"]
        assert body["content"] == "after edit"
        assert body["kind"] == "starred"
        assert "preview_version" in body

    def test_image_job_accepts_prompt_template(self, client: httpx.Client, new_user: dict):
        """`prompt_template` is an optional start-job field; it must never be
        rejected as unknown input (the job may still fail downstream when no
        OffloadMQ agent is online in the test environment)."""
        r = client.post(
            "/api/images/jobs",
            headers=new_user["headers"],
            json={
                "capability": "imggen.txt2img",
                "prompt": "a red fox",
                "prompt_template": "a {color} fox",
                "negative_prompt": None,
                "override_negative": False,
                "width": 512,
                "height": 512,
                "seed": None,
                "workflow": "txt2img",
                "input_image_id": None,
                "data_preparation": None,
            },
        )
        assert r.status_code != 422, r.text
