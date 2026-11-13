"""Explicitly trusted Python apps with cached uv environments and local Ollama."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from typing import Any, Callable

from offloadmq_agent.settings_util import load_agent_settings
from offloadmq_agent.ollama import get_ollama_base_url
from offloadmq_agent.transport_exec import AgentTransport
from offloadmq_agent.wire import TaskId
from .runtime_results import fit_runtime_report
from .windows_job import WindowsJob
from .reporting import (
    TaskCancelled,
    make_failure_report,
    make_success_report,
    make_cancelled_report,
    report_progress,
    report_result,
)

CACHE_ROOT = Path.home() / ".cache" / "offloadmq" / "llm-runtime"
# Serialize cache leases through execution: an environment is never modified or
# evicted while an app uses it. Other executor families remain concurrent.
_CACHE_LOCK = threading.Lock()
MAX_CAPTURE = 8 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
_WINDOWS = os.name == "nt"


def select_models(
    capability: str, payload: dict[str, Any]
) -> tuple[str, dict[str, str]]:
    if not isinstance(payload, dict):
        raise ValueError("LLM runtime payload must be an object")
    routing_model = capability.removeprefix("llm-runtime.")
    primary = payload.get("model", routing_model)
    roles = payload.get("models", {})
    if not isinstance(roles, dict):
        raise ValueError("models must map role names to Ollama model names")
    for name in [primary, *roles.values()]:
        if (
            not isinstance(name, str)
            or not name
            or any(
                c.isspace() or ord(c) < 32 or ord(c) == 127 or c in "[]" for c in name
            )
        ):
            raise ValueError(
                "model names must be non-empty strings without whitespace or capability attributes"
            )
    for role in roles:
        if (
            not isinstance(role, str)
            or not role
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in role)
        ):
            raise ValueError(
                "model role names must be non-empty and contain no whitespace"
            )
    if primary != routing_model:
        raise ValueError("payload.model must match the model in capability")
    return primary, dict(roles)


def require_enabled(
    capability: str, payload: dict[str, Any] | None = None
) -> dict[str, Any]:
    cfg = load_agent_settings()
    allowed = cfg.get("sensitive_allowed_caps", cfg.get("sensitive-allowed-caps", []))
    if cfg.get("llm_runtime_enabled") is not True or capability not in allowed:
        raise ValueError(
            "LLM runtime requires llm_runtime_enabled=true and explicit sensitive capability approval"
        )
    if payload is not None:
        primary, roles = select_models(capability, payload)
        missing = sorted(
            {f"llm-runtime.{name}" for name in [primary, *roles.values()]}
            - set(allowed)
        )
        if missing:
            raise ValueError(
                "Selected runtime models require sensitive capability approval: "
                + ", ".join(missing)
            )
    return cfg


def local_path(root: Path, name: str) -> Path:
    if (
        not isinstance(name, str)
        or not name
        or Path(name).is_absolute()
        or any(c in name for c in ("\\", ":", "\0"))
        or any(p in ("", ".", "..") for p in name.split("/"))
    ):
        raise ValueError("Expected a non-empty relative path")
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError(f"Path escapes task directory: {name}")
    return path


def validate_payload(payload: dict[str, Any], data: Path) -> None:
    if not isinstance(payload, dict):
        raise ValueError("LLM runtime payload must be an object")
    local_path(data, payload.get("entrypoint", ""))
    for field in ("dependencies", "allowed_tools", "args"):
        value = payload.get(field, [])
        if field == "allowed_tools" and value is None:
            continue
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ValueError(f"{field} must be a list of strings")
    for field in ("system_prompt", "user_prompt"):
        if not isinstance(payload.get(field, ""), str):
            raise ValueError(f"{field} must be a string")
    files = payload.get("files", {})
    if not isinstance(files, dict) or not all(
        isinstance(v, str) for v in files.values()
    ):
        raise ValueError("files must map relative paths to UTF-8 source text")
    for name in files:
        local_path(data, name)
    output = payload.get("output", {})
    if not isinstance(output, dict):
        raise ValueError("output must be an object")
    names = output.get("files", [])
    if not isinstance(names, list):
        raise ValueError("output.files must be a list")
    for name in names:
        local_path(data, name)
    if output.get("data_file") is not None:
        local_path(data, output["data_file"])


def _kill(process: subprocess.Popen[bytes], job: WindowsJob | None) -> None:
    try:
        if job is not None:
            job.terminate()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    finally:
        # Also reap the root when job termination fails. Closing the job is a
        # second tree-wide kill mechanism, independent of parent PID lookup.
        if job is not None:
            job.close()
        if process.poll() is None:
            process.kill()
        process.wait()


def run_process(
    command: list[str],
    cwd: Path,
    env: dict[str, str],
    stdin: bytes,
    tick: Callable[[], None],
    output: dict[str, Any],
    prefix: str = "",
) -> int:
    # Files avoid pipe deadlocks and unbounded in-memory communicate buffers.
    with (
        tempfile.TemporaryFile() as inp,
        tempfile.TemporaryFile() as out,
        tempfile.TemporaryFile() as err,
    ):
        inp.write(stdin)
        inp.seek(0)
        tick()
        job = WindowsJob() if _WINDOWS else None
        try:
            process = subprocess.Popen(
                command,
                cwd=cwd,
                env=env,
                stdin=inp,
                stdout=out,
                stderr=err,
                start_new_session=job is None,
                creationflags=0x00000004 if job is not None else 0,  # CREATE_SUSPENDED
            )
        except BaseException:
            if job is not None:
                job.close()
            raise
        try:
            if job is not None:
                job.assign_and_resume(process.pid)
            while process.poll() is None:
                tick()
                if (
                    os.fstat(out.fileno()).st_size > MAX_CAPTURE
                    or os.fstat(err.fileno()).st_size > MAX_CAPTURE
                ):
                    raise ValueError("Process output exceeded 8 MiB per stream")
                time.sleep(0.1)
            tick()
            if (
                os.fstat(out.fileno()).st_size > MAX_CAPTURE
                or os.fstat(err.fileno()).st_size > MAX_CAPTURE
            ):
                raise ValueError("Process output exceeded 8 MiB per stream")
            return process.returncode
        finally:
            # Also reap background children left behind by a successful parent.
            try:
                _kill(process, job)
            finally:
                _capture_output(process, out, err, output, prefix)


def _capture_output(
    process: subprocess.Popen[bytes],
    out: Any,
    err: Any,
    output: dict[str, Any],
    prefix: str,
) -> None:
    out.seek(0)
    err.seek(0)
    output[prefix + "stdout"] = out.read(MAX_CAPTURE).decode("utf-8", errors="replace")
    output[prefix + "stderr"] = err.read(MAX_CAPTURE).decode("utf-8", errors="replace")
    output[prefix + "return_code"] = process.returncode
    if not prefix:
        output["text"] = output["stdout"]


def cache_project(dependencies: list[str], limit: int) -> Path:
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    spec = json.dumps(sorted(set(dependencies)), ensure_ascii=False)
    key = hashlib.sha256(("python3.11:" + spec).encode()).hexdigest()
    project = CACHE_ROOT / key
    entries = sorted(
        (p for p in CACHE_ROOT.iterdir() if p.is_dir() and p != project),
        key=lambda p: p.stat().st_mtime,
    )
    while len(entries) >= limit:
        shutil.rmtree(entries.pop(0))
    project.mkdir(exist_ok=True)
    (project / "pyproject.toml").write_text(
        '[project]\nname = "offload-runtime-app"\nversion = "0.0.0"\n'
        'requires-python = ">=3.11,<3.12"\ndependencies = ' + spec + "\n",
        encoding="utf-8",
    )
    os.utime(project, None)
    return project


def execute_llm_runtime(
    transport: AgentTransport,
    task_id: TaskId,
    capability: str,
    payload: dict[str, Any],
    data: Path,
    job_timeout: int = 600,
    output_bucket: str | None = None,
) -> bool:
    started = time.monotonic()
    output: dict[str, Any] = {"text": "", "stdout": "", "stderr": "", "files": []}
    stage = "dependencies"

    def tick() -> None:
        if time.monotonic() - started >= job_timeout:
            raise TimeoutError(f"LLM runtime exceeded {job_timeout}s")
        report_progress(transport, log=None, stage=stage, task_id=task_id)

    acquired = False
    try:
        cfg = require_enabled(capability, payload)
        validate_payload(payload, data)
        output_spec = payload.get("output", {})
        if output_spec.get("files") and not output_bucket:
            raise ValueError("output.files requires output_bucket")
        uv = shutil.which("uv")
        if not uv:
            raise ValueError("Install uv on the runner to use LLM runtime")
        while not acquired:
            tick()
            acquired = _CACHE_LOCK.acquire(timeout=0.1)
        require_enabled(capability, payload)
        project = cache_project(
            payload.get("dependencies", []),
            max(1, int(cfg.get("llm_runtime_cache_limit", 8))),
        )
        # Avoid inheriting uv project overrides or Python injection from agent's venv.
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("UV_", "PYTHON")) and k != "VIRTUAL_ENV"
        }
        env["UV_CACHE_DIR"] = str(project / "uv-cache")
        code = run_process(
            [uv, "sync", "--refresh", "--no-install-project", "--python", "3.11"],
            project,
            env,
            b"",
            tick,
            output,
            "sync_",
        )
        if code:
            raise ValueError(f"uv sync failed with exit code {code}")
        for name, content in payload.get("files", {}).items():
            path = local_path(data, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        entrypoint = local_path(data, payload["entrypoint"])
        if not entrypoint.is_file():
            raise ValueError("entrypoint was not supplied in files or attachments")
        model, models = select_models(capability, payload)
        request = {
            "system_prompt": payload.get("system_prompt", ""),
            "user_prompt": payload.get("user_prompt", ""),
            "allowed_tools": payload.get("allowed_tools"),
            "resources": payload.get("resources", {}),
            "output": output_spec,
            "data_dir": str(data.resolve()),
            "ollama_base_url": get_ollama_base_url(),
            "model": model,
            "models": models,
        }
        env.update(
            OLLAMA_HOST=request["ollama_base_url"],
            OLLAMA_MODEL=request["model"],
            OFFLOAD_LLM_MODELS=json.dumps(models),
            PYTHONUNBUFFERED="1",
            PYTHONIOENCODING="utf-8",
            OFFLOAD_DATA_DIR=str(data.resolve()),
        )
        python = (
            project
            / ".venv"
            / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        )
        env["VIRTUAL_ENV"] = str(project / ".venv")
        env["PATH"] = str(python.parent) + os.pathsep + env.get("PATH", "")
        stage = "running"
        code = run_process(
            [str(python), str(entrypoint), *payload.get("args", [])],
            data,
            env,
            json.dumps(request).encode(),
            tick,
            output,
        )
        if code:
            raise ValueError(f"App exited with code {code}")
        stage = "outputs"
        if output_spec.get("data_file"):
            path = local_path(data, output_spec["data_file"])
            if path.stat().st_size > MAX_CAPTURE:
                raise ValueError("JSON output exceeds 8 MiB")
            output["data"] = json.loads(path.read_text(encoding="utf-8"))
        for name in output_spec.get("files", []):
            tick()
            path = local_path(data, name)
            if path.stat().st_size > MAX_FILE:
                raise ValueError("Output file exceeds 64 MiB")
            content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
            uid = transport.upload_file(
                str(output_bucket), name, path.read_bytes(), content_type
            )
            output["files"].append(
                {
                    "filename": name,
                    "file_uid": uid,
                    "bucket_uid": output_bucket,
                    "content_type": content_type,
                }
            )
        report = make_success_report(
            task_id, capability, output, time.monotonic() - started
        )
    except TaskCancelled:
        report = make_cancelled_report(task_id, capability, output)
    except Exception as exc:
        output["error"] = str(exc)
        report = make_failure_report(
            task_id, capability, str(exc), time.monotonic() - started, output
        )
    finally:
        if acquired:
            _CACHE_LOCK.release()
    return report_result(transport, fit_runtime_report(report))
