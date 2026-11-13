"""Runtime policy, real subprocess lifecycle, cache and app contract tests."""

import json
import os
from pathlib import Path
import shutil
import sys
import time

import pytest

from offloadmq_agent.cap_policy import compute_registration_caps
from offloadmq_agent.exec import llm_runtime as rt
from offloadmq_agent.wire import TaskId

CAP = "llm-runtime.test:latest"


class Transport:
    def __init__(self):
        self.result = None
        self.uploads = []

    def post_task_progress(self, *args, **kwargs):
        return self

    def post_task_result(self, report, **kwargs):
        self.result = report
        return self

    def upload_file(self, bucket, name, content, content_type):
        self.uploads.append((bucket, name, content))
        return "file-1"

    status_code = 200
    content = b""

    def raise_for_status(self):
        pass


@pytest.fixture
def enabled(monkeypatch, tmp_path):
    cfg = {"llm_runtime_enabled": True, "sensitive_allowed_caps": [CAP]}
    monkeypatch.setattr(rt, "load_agent_settings", lambda: cfg)
    monkeypatch.setattr(rt, "CACHE_ROOT", tmp_path / "cache")
    return cfg


def test_policy_requires_both_switches():
    for cfg in ({}, {"llm_runtime_enabled": True}, {"sensitive_allowed_caps": [CAP]}):
        assert CAP not in compute_registration_caps(cfg, [CAP])
    assert CAP in compute_registration_caps(
        {"llm_runtime_enabled": True, "sensitive_allowed_caps": [CAP]}, [CAP]
    )


def test_disabled_direct_execution_never_starts(monkeypatch, tmp_path):
    monkeypatch.setattr(rt, "load_agent_settings", lambda: {})
    monkeypatch.setattr(rt.subprocess, "Popen", lambda *a, **kw: pytest.fail("spawned"))
    transport = Transport()
    rt.execute_llm_runtime(transport, TaskId(id="1", cap=CAP), CAP, {}, tmp_path)
    assert "explicit sensitive" in transport.result.output["error"]


@pytest.mark.parametrize("name", ["../x", "/x", "a/../x", "C:\\x", "a\\x", ""])
def test_paths(tmp_path, name):
    with pytest.raises(ValueError):
        rt.local_path(tmp_path, name)


def test_symlink_escape(tmp_path):
    (tmp_path / "escape").symlink_to(tmp_path.parent, target_is_directory=True)
    with pytest.raises(ValueError):
        rt.local_path(tmp_path, "escape/file")


def test_lru_and_default_limit(enabled):
    first = rt.cache_project(["a", "b"], 8)
    assert rt.cache_project(["b", "a", "a"], 8) == first
    for i in range(8):
        rt.cache_project([f"package{i}"], 8)
    assert len(list(rt.CACHE_ROOT.iterdir())) == 8
    assert not first.exists()
    rt.cache_project([], 2)
    assert len(list(rt.CACHE_ROOT.iterdir())) == 2


def test_process_captures_large_streams_without_deadlock(tmp_path):
    output = {}
    code = rt.run_process(
        [
            sys.executable,
            "-c",
            "import sys;print('x'*200000);sys.stderr.write('y'*200000)",
        ],
        tmp_path,
        dict(os.environ),
        b"",
        lambda: None,
        output,
    )
    assert code == 0
    assert len(output["stderr"]) == 200000
    assert output["text"] == output["stdout"]


@pytest.mark.parametrize("error", [TimeoutError, rt.TaskCancelled])
def test_process_stop_retains_output(tmp_path, error):
    output = {}
    start = time.monotonic()

    def tick():
        if time.monotonic() - start > 0.4:
            raise error("stop")

    with pytest.raises(error):
        rt.run_process(
            [sys.executable, "-u", "-c", "import time;print('partial');time.sleep(30)"],
            tmp_path,
            dict(os.environ),
            b"",
            tick,
            output,
        )
    assert "partial" in output["stdout"]
    assert time.monotonic() - start < 5


def test_capture_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(rt, "MAX_CAPTURE", 1000)
    output = {}
    with pytest.raises(ValueError, match="output exceeded"):
        rt.run_process(
            [sys.executable, "-c", "print('x'*10000)"],
            tmp_path,
            dict(os.environ),
            b"",
            lambda: None,
            output,
        )
    assert len(output["stdout"]) == 1000


def test_app_contract_with_real_uv(enabled, tmp_path, monkeypatch):
    if not shutil.which("uv"):
        pytest.skip("uv required")
    enabled["sensitive_allowed_caps"].append("llm-runtime.critic:latest")
    transport = Transport()
    app = """import json, sys
from pathlib import Path
request = json.load(sys.stdin)
assert request['allowed_tools'] == []
assert request['model'] == 'test:latest'
assert request['models'] == {'critic': 'critic:latest'}
import os
assert os.environ['OLLAMA_MODEL'] == 'test:latest'
assert json.loads(os.environ['OFFLOAD_LLM_MODELS']) == request['models']
assert request['system_prompt'] == 'system'
assert Path('resource.txt').read_text() == 'attachment'
Path('data.json').write_text(json.dumps({'answer': 42}))
Path('result.txt').write_text('artifact')
print(request['user_prompt'])
print('diagnostic', file=sys.stderr)
"""
    (tmp_path / "resource.txt").write_text("attachment")
    payload = {
        "entrypoint": "app.py",
        "model": "test:latest",
        "models": {"critic": "critic:latest"},
        "files": {"app.py": app},
        "dependencies": [],
        "allowed_tools": [],
        "system_prompt": "system",
        "user_prompt": "hello",
        "output": {"data_file": "data.json", "files": ["result.txt"]},
    }
    # Reuse the same environment but sync on both invocations.
    calls = []
    original = rt.run_process

    def record(command, *args, **kwargs):
        calls.append(command)
        return original(command, *args, **kwargs)

    monkeypatch.setattr(rt, "run_process", record)
    for _ in range(2):
        rt.execute_llm_runtime(
            transport,
            TaskId(id="1", cap=CAP),
            CAP,
            payload,
            tmp_path,
            output_bucket="bucket",
            job_timeout=60,
        )
        assert transport.result.status.status == "success", transport.result.output
        assert transport.result.output["text"] == "hello\n"
        assert transport.result.output["stderr"] == "diagnostic\n"
        assert transport.result.output["data"] == {"answer": 42}
        assert transport.uploads[-1] == ("bucket", "result.txt", b"artifact")
    assert sum("sync" in c and "--refresh" in c for c in calls) == 2
    assert len(list(rt.CACHE_ROOT.iterdir())) == 1


def test_cache_wait_obeys_timeout(enabled, tmp_path):
    transport = Transport()
    rt._CACHE_LOCK.acquire()
    try:
        rt.execute_llm_runtime(
            transport,
            TaskId(id="1", cap=CAP),
            CAP,
            {"entrypoint": "app.py"},
            tmp_path,
            job_timeout=1,
        )
    finally:
        rt._CACHE_LOCK.release()
    assert "exceeded" in transport.result.output["error"]
    assert not rt.CACHE_ROOT.exists()


def test_pipeline_blocks_downloads_when_disabled(monkeypatch, tmp_path):
    from offloadmq_agent.pipeline import _run_sync_pipeline
    from offloadmq_agent.models import Task, TaskStatus

    monkeypatch.setattr(rt, "load_agent_settings", lambda: {})
    # Gate runs before the transport or context is consulted.
    task = Task(id="1", capability=CAP, payload={"entrypoint": "app.py"})
    result = _run_sync_pipeline(task, None, None, None, tmp_path)
    assert result.status == TaskStatus.FAILED
    assert "explicit sensitive" in result.error


def test_bad_outputs_fail_before_dependency_install(enabled, tmp_path, monkeypatch):
    monkeypatch.setattr(rt.subprocess, "Popen", lambda *a, **kw: pytest.fail("spawned"))
    transport = Transport()
    rt.execute_llm_runtime(
        transport,
        TaskId(id="1", cap=CAP),
        CAP,
        {"entrypoint": "app.py", "output": {"files": ["out.txt"]}},
        tmp_path,
    )
    assert "requires output_bucket" in transport.result.output["error"]


@pytest.mark.parametrize(
    "payload",
    [
        {"model": "other"},
        {"model": None},
        {"model": ""},
        {"models": []},
        {"models": {"critic": None}},
        {"models": {"critic": "gemma[tools]"}},
        {"models": {"": "gemma:latest"}},
    ],
)
def test_invalid_input_models_are_rejected(payload):
    with pytest.raises(ValueError):
        rt.select_models(CAP, payload)


def test_selected_role_models_require_local_approval_before_spawn(
    enabled, tmp_path, monkeypatch
):
    monkeypatch.setattr(rt.subprocess, "Popen", lambda *a, **kw: pytest.fail("spawned"))
    transport = Transport()
    rt.execute_llm_runtime(
        transport,
        TaskId(id="1", cap=CAP),
        CAP,
        {
            "entrypoint": "app.py",
            "model": "test:latest",
            "models": {"critic": "gemma:latest"},
        },
        tmp_path,
    )
    assert "llm-runtime.gemma:latest" in transport.result.output["error"]
    assert not rt.CACHE_ROOT.exists()
