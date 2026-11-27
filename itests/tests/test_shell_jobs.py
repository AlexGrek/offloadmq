"""shell.* jobs end to end: workspace, env, credentials, input files, artifacts.

Needs the itest agent (Makefile) with shell.posix and shell.any opted in.
"""
import hashlib

import requests

SERVER_URL = "http://localhost:3069"
API_KEY = "client_secret_key_123"
HEADERS = {"X-API-Key": API_KEY}


def _bucket(rm_after_task: bool = False) -> str:
    url = f"{SERVER_URL}/api/storage/bucket/create"
    if rm_after_task:
        url += "?rm_after_task=true"
    resp = requests.post(url, headers=HEADERS, timeout=10)
    assert resp.status_code == 201, resp.text
    return resp.json()["bucket_uid"]


def _run(capability: str, payload: dict, **extra) -> dict:
    body = {
        "capability": capability,
        "urgent": True,
        "payload": payload,
        "apiKey": API_KEY,
        **extra,
    }
    resp = requests.post(f"{SERVER_URL}/api/task/submit_blocking", json=body, timeout=60)
    resp.raise_for_status()
    return resp.json()


def test_string_payload_is_accepted():
    result = _run("shell.posix", "echo legacy")
    assert result["status"] == "completed", result
    assert result["result"]["stdout"] == "legacy\n"


def test_env_workspace_and_masked_credential():
    result = _run("shell.any", {
        "command": 'echo "$GREETING from $OMQ_SHELL"; echo "token=$TOKEN"; pwd',
        "env": {"GREETING": "hello"},
        "workspace": "itest/${task_id}-${rand}",
        "credentials": [{"name": "TOKEN", "type": "value", "value": "itest-secret-42"}],
    })
    assert result["status"] == "completed", result
    out = result["result"]
    lines = out["stdout"].splitlines()
    assert lines[0].startswith("hello from ")
    assert lines[1] == "token=[MASKED]"
    assert "/itest/" in lines[2]
    assert out["exit_code"] == 0
    # The payload itself is stored as sent; what the agent reports is masked.
    assert "itest-secret-42" not in str(out) + (result.get("log") or "")
    assert not (result.get("log") or "").startswith("starting")


def test_failure_reports_exit_code():
    result = _run("shell.posix", {"command": "echo nope >&2; exit 7"})
    assert result["status"] == "failed", result
    assert result["result"]["exit_code"] == 7


def test_input_bucket_and_artifacts_round_trip():
    inputs = _bucket(rm_after_task=True)
    up = requests.post(
        f"{SERVER_URL}/api/storage/bucket/{inputs}/upload",
        headers=HEADERS, files={"file": ("in.txt", b"payload-bytes")}, timeout=10,
    )
    assert up.status_code == 201, up.text
    outputs = _bucket()

    result = _run(
        "shell.posix",
        {
            "command": "mkdir -p out && tr a-z A-Z < in.txt > out/upper.txt",
            "artifacts": ["out/**"],
        },
        file_bucket=[inputs],
        output_bucket=outputs,
    )
    assert result["status"] == "completed", result
    [artifact] = result["result"]["artifacts"]
    assert artifact["path"] == "out/upper.txt"

    dl = requests.get(
        f"{SERVER_URL}/api/storage/bucket/{outputs}/file/{artifact['file_uid']}",
        headers=HEADERS, timeout=10,
    )
    assert dl.status_code == 200
    assert dl.content == b"PAYLOAD-BYTES"
    assert hashlib.sha256(dl.content).hexdigest() == artifact["sha256"]
    requests.delete(f"{SERVER_URL}/api/storage/bucket/{outputs}", headers=HEADERS, timeout=10)
