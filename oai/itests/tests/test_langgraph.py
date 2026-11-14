"""LangGraph API validation plus optional real OffloadMQ/runner lifecycle tests."""
import time

import httpx
import pytest


def request(capability="llm-runtime.test", **changes):
    result = {
        "capability": capability, "models": {},
        "main_py": "import json,sys\nfrom pathlib import Path\nfrom tools import echo\nr=json.load(sys.stdin)\nprint(echo(r['user_prompt']))\nprint('diagnostic',file=sys.stderr)\nPath('data.json').write_text(json.dumps({'role':r['models']['critic']}))\nPath('report.txt').write_text('artifact body')\n",
        "tools_py": "def echo(text): return 'Answer: '+text\n",
        "pyproject": "[project]\nname='test'\nversion='0.1.0'\ndependencies=[]\n",
        "system_prompt": "Test system", "user_prompt": "Test user", "allowed_tools": [],
        "resources": {}, "output": {"data_file": "data.json", "files": ["report.txt"]},
        "runtime_secs": 60,
    }
    result.update(changes)
    return result


def wait_for_result(client: httpx.Client, headers: dict, job_id: str) -> dict:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        response = client.post(f"/api/langgraph/jobs/{job_id}/poll", headers=headers)
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in ("completed", "failed", "canceled"):
            return job
        time.sleep(0.25)
    raise AssertionError("LangGraph run did not finish in 90 seconds")


class TestLanggraphAuthorization:
    @pytest.mark.parametrize("method,path", [
        ("GET", "/capabilities"), ("GET", "/jobs"), ("POST", "/jobs"),
        ("GET", "/jobs/1"), ("POST", "/jobs/1/poll"), ("POST", "/jobs/1/cancel"),
        ("POST", "/jobs/1/retry"), ("DELETE", "/jobs/1"), ("GET", "/jobs/1/artifacts/0"),
    ])
    @pytest.mark.parametrize("token", [None, "invalid-token"])
    def test_auth_required(self, fresh_client: httpx.Client, method: str, path: str, token: str | None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        response = fresh_client.request(method, "/api/langgraph" + path, headers=headers, json={})
        assert response.status_code == 401

    def test_new_user_has_empty_history(self, client: httpx.Client, new_user: dict):
        response = client.get('/api/langgraph/jobs', headers=new_user['headers'])
        assert response.status_code == 200
        assert response.json() == []


class TestLanggraphValidation:
    @pytest.mark.parametrize("changes", [
        {"capability": "llm.test"}, {"models": {"bad role": "model"}},
        {"main_py": ""}, {"runtime_secs": 0}, {"runtime_secs": 3601},
        {"pyproject": "invalid ["}, {"pyproject": "[project]\ndependencies=[1]"},
        {"pyproject": "[project]\ndependencies=[]\n[tool.uv.sources]"},
        {"output": {"files": ["../escape.txt"]}}, {"output": {"files": ["main.py"]}},
        {"output": {"files": ["duplicate"], "data_file": "duplicate"}},
    ])
    def test_invalid_input_does_not_create_job(self, client: httpx.Client, new_user: dict, changes: dict):
        headers = new_user['headers']
        response = client.post('/api/langgraph/jobs', headers=headers, json=request(**changes))
        assert response.status_code == 400, response.text
        assert isinstance(response.json()['error'], str)
        assert client.get('/api/langgraph/jobs', headers=headers).json() == []


class TestLanggraphRuntime:
    def test_real_runner_output_artifacts_ownership_and_prompt_library(self, client: httpx.Client, new_user: dict, session_headers: dict, langgraph_capability: str):
        headers = new_user['headers']
        model = langgraph_capability.removeprefix('llm-runtime.')
        body = request(langgraph_capability, models={"critic": model})
        response = client.post('/api/langgraph/jobs', headers=headers, json=body)
        assert response.status_code == 201, response.text
        job_id = response.json()['job_id']
        try:
            job = wait_for_result(client, headers, job_id)
            assert job['status'] == 'completed', job
            assert job['request'] == body
            assert job['result']['stdout'] == 'Answer: Test user\n'
            assert job['result']['stderr'] == 'diagnostic\n'
            assert job['result']['data'] == {'role': model}
            assert job['artifacts'][0]['filename'] == 'report.txt'
            summary = client.get('/api/langgraph/jobs', headers=headers).json()[0]
            assert 'request' not in summary and 'result' not in summary
            artifact = client.get(f'/api/langgraph/jobs/{job_id}/artifacts/0', headers=headers)
            assert artifact.status_code == 200 and artifact.text == 'artifact body'
            assert artifact.headers['content-disposition'].startswith('attachment;')
            for method, suffix in [('GET', ''), ('POST', '/poll'), ('POST', '/cancel'), ('POST', '/retry'), ('DELETE', ''), ('GET', '/artifacts/0')]:
                assert client.request(method, f'/api/langgraph/jobs/{job_id}{suffix}', headers=session_headers).status_code == 404
            for bucket, prompt in [('langgraph-user', 'Test user'), ('langgraph-system', 'Test system')]:
                library = client.get(f'/api/prompts/{bucket}', headers=headers).json()
                assert prompt in [item['content'] for item in library['recent']]
        finally:
            client.delete(f'/api/langgraph/jobs/{job_id}', headers=headers)

    def test_failure_preserves_streams_and_retry_replays_snapshot(self, client: httpx.Client, new_user: dict, langgraph_capability: str):
        headers = new_user['headers']
        body = request(langgraph_capability, main_py="import sys\nprint('partial answer')\nprint('failure detail',file=sys.stderr)\nsys.exit(3)", output={"files": []})
        first = client.post('/api/langgraph/jobs', headers=headers, json=body)
        assert first.status_code == 201, first.text
        ids = [first.json()['job_id']]
        try:
            job = wait_for_result(client, headers, ids[0])
            assert job['status'] == 'failed', job
            assert job['result']['stdout'] == 'partial answer\n'
            assert job['result']['stderr'] == 'failure detail\n'
            retry = client.post(f'/api/langgraph/jobs/{ids[0]}/retry', headers=headers)
            assert retry.status_code == 201, retry.text
            ids.append(retry.json()['job_id'])
            assert ids[0] != ids[1]
            assert wait_for_result(client, headers, ids[1])['request'] == job['request']
        finally:
            for job_id in ids:
                client.delete(f'/api/langgraph/jobs/{job_id}', headers=headers)

    def test_cancellation_is_terminal(self, client: httpx.Client, new_user: dict, langgraph_capability: str):
        headers = new_user['headers']
        body = request(langgraph_capability, main_py="import time\nprint('starting',flush=True)\ntime.sleep(50)", output={"files": []})
        response = client.post('/api/langgraph/jobs', headers=headers, json=body)
        assert response.status_code == 201, response.text
        job_id = response.json()['job_id']
        try:
            assert client.delete(f'/api/langgraph/jobs/{job_id}', headers=headers).status_code == 400
            cancel = client.post(f'/api/langgraph/jobs/{job_id}/cancel', headers=headers)
            assert cancel.status_code == 200, cancel.text
            assert wait_for_result(client, headers, job_id)['status'] == 'canceled'
        finally:
            client.delete(f'/api/langgraph/jobs/{job_id}', headers=headers)
