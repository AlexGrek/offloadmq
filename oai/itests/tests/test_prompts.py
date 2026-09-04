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
