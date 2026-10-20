"""MQ-independent contract for persistent describe/generate chains."""
import httpx
import pytest

ROOT = "/api/image-cycles/jobs"
MISSING = "999999999999999999"
PARAMS = {
    "initial_prompt": "A fox", "input_image_id": None,
    "describe_prompt": "Describe this image", "vision_model": "llm.vision",
    "image_model": "imggen.paint", "cycles": 2, "width": 1024, "height": 1024,
}
OPERATIONS = [("GET", ROOT), ("POST", ROOT), ("GET", f"{ROOT}/{MISSING}"),
              ("DELETE", f"{ROOT}/{MISSING}"),
              *[("POST", f"{ROOT}/{MISSING}/{action}") for action in ("poll", "cancel", "retry", "restart", "pause", "resume")]]
OPERATIONS.append(("PATCH", ROOT + "/999999999999999999/models"))
OPERATIONS.append(("POST", f"{ROOT}/{MISSING}/steps/0/restart"))
OPERATIONS.append(("PATCH", f"{ROOT}/{MISSING}/vision-prompt"))


class TestImageCycles:
    @pytest.mark.parametrize("method,path", OPERATIONS)
    @pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer garbage"}])
    def test_requires_auth(self, fresh_client: httpx.Client, method: str, path: str, headers: dict):
        response = fresh_client.request(method, path, headers=headers, json=PARAMS)
        assert response.status_code == 401

    def test_new_user_history_is_empty(self, client: httpx.Client, new_user: dict):
        response = client.get(ROOT, headers=new_user["headers"])
        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.parametrize("method,path", OPERATIONS[2:])
    def test_missing_run(self, client: httpx.Client, new_user: dict, method: str, path: str):
        response = client.request(method, path, headers=new_user["headers"], **({"json": {"describe_prompt": "Describe"}} if method == "PATCH" else {}))
        assert response.status_code == 404
        assert isinstance(response.json()["error"], str)

    @pytest.mark.parametrize("change", [
        {"initial_prompt": None}, {"input_image_id": "42"}, {"cycles": 0}, {"cycles": 51},
        {"width": 0}, {"height": 2049}, {"describe_prompt": "  "}, {"vision_model": "imggen.wrong"},
    ])
    def test_rejects_invalid_inputs_before_calling_mq(self, client: httpx.Client, new_user: dict, change: dict):
        response = client.post(ROOT, headers=new_user["headers"], json={**PARAMS, **change})
        assert response.status_code == 400
        assert isinstance(response.json()["error"], str)
