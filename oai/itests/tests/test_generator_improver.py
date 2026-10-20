"""Generator Improver validation and authentication, without an MQ dependency."""
import httpx
import pytest

ROOT = "/api/generator-improver/jobs"
PARAMS = {"initial_prompt": "A fox", "input_image_id": None,
          "describe_prompt": "Assess image quality", "vision_model": "llm.vision",
          "image_model": "imggen.refine", "bootstrap_model": "imggen.paint",
          "expected_quality": 95, "max_steps": 3, "width": 1024, "height": 1024}
OPERATIONS = [("GET", ROOT), ("POST", ROOT), ("GET", ROOT + "/999999999999999999"),
              ("DELETE", ROOT + "/999999999999999999"),
              *[("POST", ROOT + "/999999999999999999/" + a) for a in ("poll", "cancel", "retry", "restart", "pause", "resume")]]
OPERATIONS.append(("PATCH", ROOT + "/999999999999999999/models"))
OPERATIONS.append(("POST", ROOT + "/999999999999999999/steps/0/restart"))
OPERATIONS.append(("PATCH", ROOT + "/999999999999999999/vision-prompt"))


class TestGeneratorImprover:
    @pytest.mark.parametrize("method,path", OPERATIONS)
    @pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer garbage"}])
    def test_requires_auth(self, fresh_client: httpx.Client, method: str, path: str, headers: dict):
        assert fresh_client.request(method, path, headers=headers, json=PARAMS).status_code == 401

    def test_empty_history(self, client: httpx.Client, new_user: dict):
        response = client.get(ROOT, headers=new_user["headers"])
        assert response.status_code == 200
        assert response.json() == []

    def test_restart_step_requires_owned_run(self, client: httpx.Client, new_user: dict):
        response = client.post(ROOT + "/999999999999999999/steps/0/restart", headers=new_user["headers"])
        assert response.status_code == 404
        assert isinstance(response.json()["error"], str)

    def test_vision_prompt_requires_owned_run(self, client: httpx.Client, new_user: dict):
        response = client.patch(ROOT + "/999999999999999999/vision-prompt", headers=new_user["headers"], json={"describe_prompt": "Assess quality"})
        assert response.status_code == 404
        assert isinstance(response.json()["error"], str)

    @pytest.mark.parametrize("change", [{"expected_quality": 0}, {"expected_quality": 101},
                                         {"expected_quality": None}, {"max_steps": 0},
                                         {"max_steps": 51}, {"max_steps": None}])
    def test_rejects_invalid_quality_and_step_limits(self, client: httpx.Client, new_user: dict, change: dict):
        response = client.post(ROOT, headers=new_user["headers"], json={**PARAMS, **change})
        assert response.status_code == 400
        assert isinstance(response.json()["error"], str)
