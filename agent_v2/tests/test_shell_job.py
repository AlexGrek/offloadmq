"""shell.* capability family: substitution, env, workspace, credentials, artifacts, executor."""
from __future__ import annotations

import os
import shutil
import stat
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from offloadmq_agent.cap_policy import is_sensitive_capability
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.exec.shell.artifacts import ArtifactError, collect, validate_patterns
from offloadmq_agent.exec.shell.credentials import (
    CredentialError,
    resolve_credentials,
    validate_credentials,
)
from offloadmq_agent.exec.shell.executor import (
    ShellJobError,
    execute_shell_job,
    prepare_shell_job,
    run_prepared,
)
from offloadmq_agent.exec.shell.masking import MASK, Masker
from offloadmq_agent.exec.shell.shells import ShellSpec, detect_shells, shell_capabilities
from offloadmq_agent.exec.shell.subst import (
    SubstContext,
    SubstitutionError,
    build_env,
    substitute,
)
from offloadmq_agent.exec.shell.workspace import WorkspaceError, resolve_workspace
from offloadmq_agent.models import Task
from offloadmq_agent.wire import TaskId, TaskResultReport

unix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell semantics")
TID = TaskId(id="task-1", cap="shell.posix")


# --------------------------------------------------------------------------
# substitution
# --------------------------------------------------------------------------

def test_rand_is_stable_per_task_and_sliceable() -> None:
    ctx = SubstContext(task_id="t")
    a = substitute("${rand}", ctx, {})
    assert len(a) == 12 and a == substitute("${rand}", ctx, {})
    assert substitute("${rand:4}", ctx, {}) == a[:4]
    assert substitute("${rand:32}", ctx, {}).startswith(a)
    with pytest.raises(SubstitutionError):
        substitute("${rand:99}", ctx, {})


def test_env_lookup_defaults_escape_and_shorthand() -> None:
    ctx = SubstContext(task_id="t-9")
    env = {"A": "1", "EMPTY": ""}
    assert substitute("${env:A}/${A}/${task_id}", ctx, env) == "1/1/t-9"
    assert substitute("${env:MISSING:-dflt}", ctx, env) == "dflt"
    assert substitute("${env:EMPTY:-dflt}", ctx, env) == "dflt"
    assert substitute("$${A}", ctx, env) == "${A}"
    with pytest.raises(SubstitutionError, match="MISSING"):
        substitute("${env:MISSING}", ctx, env)
    with pytest.raises(SubstitutionError):
        substitute("${not a name}", ctx, env)


def test_build_env_applies_in_order_and_null_removes() -> None:
    ctx = SubstContext(task_id="t")
    env = build_env(
        {"ROOT": "/opt", "BIN": "${env:ROOT}/bin", "DROP": None, "N": 3, "B": True},
        inherit=True, ctx=ctx, base={"DROP": "x", "PATH": "/usr/bin"},
    )
    assert env["BIN"] == "/opt/bin"
    assert "DROP" not in env
    assert env["N"] == "3" and env["B"] == "true"
    assert env["PATH"] == "/usr/bin"


def test_build_env_without_inherit_keeps_only_basics() -> None:
    env = build_env({}, inherit=False, ctx=SubstContext(task_id="t"),
                    base={"PATH": "/bin", "SECRET_TOKEN": "x"})
    assert env == {"PATH": "/bin"}


def test_build_env_rejects_bad_names_and_values() -> None:
    ctx = SubstContext(task_id="t")
    with pytest.raises(SubstitutionError):
        build_env({"1BAD": "x"}, True, ctx, base={})
    with pytest.raises(SubstitutionError):
        build_env({"OK": {"nested": 1}}, True, ctx, base={})


# --------------------------------------------------------------------------
# workspace
# --------------------------------------------------------------------------

def _settings(tmp_path: Path, **extra: Any) -> dict[str, Any]:
    return {"shell_workspace_root": str(tmp_path / "root"), **extra}


def test_relative_workspace_resolves_under_root_and_auto_cleans_rand(tmp_path: Path) -> None:
    ctx = SubstContext(task_id="t")
    ws = resolve_workspace("proj/${env:NAME}/${rand}", None, ctx, {"NAME": "acme"},
                           _settings(tmp_path), TID)
    assert ws.path == (tmp_path / "root" / "proj" / "acme" / ctx.rand[:12]).resolve()
    assert ws.path.is_dir() and ws.created and ws.cleanup == "always"
    assert ws.remove(succeeded=False)
    assert not ws.path.exists()


def test_fixed_workspace_defaults_to_never_cleanup(tmp_path: Path) -> None:
    ws = resolve_workspace("fixed", "auto", SubstContext(task_id="t"), {},
                           _settings(tmp_path), TID)
    assert ws.cleanup == "never"
    assert not ws.remove(succeeded=True)
    assert ws.path.exists()


def test_pre_existing_workspace_is_never_deleted(tmp_path: Path) -> None:
    existing = tmp_path / "mine"
    existing.mkdir()
    ws = resolve_workspace(str(existing), "always", SubstContext(task_id="t"), {},
                           _settings(tmp_path), TID)
    assert not ws.created
    assert not ws.remove(succeeded=True)
    assert existing.exists()


def test_on_success_cleanup(tmp_path: Path) -> None:
    ws = resolve_workspace("a", "on_success", SubstContext(task_id="t"), {},
                           _settings(tmp_path), TID)
    assert not ws.remove(succeeded=False)
    assert ws.remove(succeeded=True)


def test_restricted_workspace_must_stay_inside_root(tmp_path: Path) -> None:
    settings = _settings(tmp_path, shell_restrict_workspace=True)
    ctx = SubstContext(task_id="t")
    with pytest.raises(WorkspaceError, match="outside"):
        resolve_workspace(str(tmp_path / "elsewhere"), None, ctx, {}, settings, TID)
    with pytest.raises(WorkspaceError, match="outside"):
        resolve_workspace("../escape", None, ctx, {}, settings, TID)
    assert resolve_workspace("inside", None, ctx, {}, settings, TID).path.is_dir()


def test_workspace_errors(tmp_path: Path) -> None:
    ctx = SubstContext(task_id="t")
    (tmp_path / "file").write_text("x")
    with pytest.raises(WorkspaceError, match="not a directory"):
        resolve_workspace(str(tmp_path / "file"), None, ctx, {}, _settings(tmp_path), TID)
    with pytest.raises(WorkspaceError, match="cleanup"):
        resolve_workspace("a", "sometimes", ctx, {}, _settings(tmp_path), TID)
    with pytest.raises(WorkspaceError, match="UNSET"):
        resolve_workspace("${env:UNSET}", None, ctx, {}, _settings(tmp_path), TID)


# --------------------------------------------------------------------------
# masking + credentials
# --------------------------------------------------------------------------

def test_masker_longest_first_and_multiline() -> None:
    masker = Masker(["abcd", "abcdefgh", "ab"])  # "ab" is too short to mask
    assert masker("x abcdefgh y abcd ab") == f"x {MASK} y {MASK} ab"
    masker.add("line-one\nline-two")
    assert masker("got line-two!") == f"got {MASK}!"


def _resolve(specs: list[dict[str, Any]], tmp_path: Path, masker: Masker | None = None,
             agent_env: dict[str, str] | None = None) -> dict[str, str]:
    scratch = tmp_path / "scratch"
    scratch.mkdir(exist_ok=True)
    return resolve_credentials(
        validate_credentials(specs),
        shell=ShellSpec("posix", "/bin/sh"),
        env={"PATH": os.environ.get("PATH", "")},
        cwd=tmp_path,
        scratch_dir=scratch,
        masker=masker or Masker(),
        agent_env=agent_env or {},
    ).env


def test_inline_credentials(tmp_path: Path) -> None:
    masker = Masker()
    env = _resolve([
        {"name": "TOKEN", "type": "value", "value": "tok-123456"},
        {"name": "aws", "type": "map", "values": {"AWS_KEY": "AKIA0000", "AWS_SECRET": "s3cr3t!!"}},
        {"name": "REG", "type": "login_password", "login": "robot", "password": "pw-98765"},
        {"name": "DB", "type": "login_password", "login": "u1", "password": "pw-11111",
         "login_var": "DB_USER", "password_var": "DB_PASS"},
    ], tmp_path, masker)
    assert env == {
        "TOKEN": "tok-123456", "AWS_KEY": "AKIA0000", "AWS_SECRET": "s3cr3t!!",
        "REG_LOGIN": "robot", "REG_PASSWORD": "pw-98765", "DB_USER": "u1", "DB_PASS": "pw-11111",
    }
    assert masker("tok-123456 s3cr3t!! pw-98765") == f"{MASK} {MASK} {MASK}"


def test_agent_side_credentials(tmp_path: Path) -> None:
    secret_file = tmp_path / "kube"
    secret_file.write_text("apiVersion: v1\ntoken: abcdef\n")
    env = _resolve([
        {"name": "GH", "type": "agent_env", "from": "GITHUB_TOKEN"},
        {"name": "KUBE", "type": "agent_file", "path": str(secret_file)},
    ], tmp_path, agent_env={"GITHUB_TOKEN": "ghp_xyz123"})
    assert env["GH"] == "ghp_xyz123"
    assert env["KUBE"] == "apiVersion: v1\ntoken: abcdef"


@unix_only
def test_agent_cmd_credential(tmp_path: Path) -> None:
    env = _resolve([{"name": "VAULT", "type": "agent_cmd", "command": "printf 'from-vault\\n'"}],
                   tmp_path)
    assert env["VAULT"] == "from-vault"


@unix_only
def test_agent_cmd_failure_masks_output(tmp_path: Path) -> None:
    spec = {"name": "V", "type": "agent_cmd",
            "command": "echo leaked-secret; echo 'bad leaked-secret' >&2; exit 4"}
    with pytest.raises(CredentialError) as exc:
        _resolve([spec], tmp_path)
    assert "exited with 4" in str(exc.value)
    assert "leaked-secret" not in str(exc.value)


@unix_only
def test_file_credentials_are_private(tmp_path: Path) -> None:
    env = _resolve([{"name": "KEY", "type": "value", "value": "pem-data", "as": "file"}], tmp_path)
    path = Path(env["KEY"])
    assert path.read_text() == "pem-data"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert path.parent == tmp_path / "scratch"


def test_credential_errors_never_include_the_value(tmp_path: Path) -> None:
    with pytest.raises(CredentialError, match="NOPE"):
        _resolve([{"name": "X", "type": "agent_env", "from": "NOPE"}], tmp_path)
    with pytest.raises(CredentialError, match="cannot read"):
        _resolve([{"name": "X", "type": "agent_file", "path": str(tmp_path / "missing")}], tmp_path)
    with pytest.raises(CredentialError, match="set twice"):
        _resolve([{"name": "X", "type": "value", "value": "aaaa"},
                  {"name": "X", "type": "value", "value": "bbbb"}], tmp_path)
    with pytest.raises(CredentialError, match="type"):
        validate_credentials([{"name": "X", "type": "magic"}])
    with pytest.raises(CredentialError, match="variable name"):
        validate_credentials([{"name": "has space", "type": "value", "value": "v"}])


# --------------------------------------------------------------------------
# artifacts
# --------------------------------------------------------------------------

def test_collect_artifacts(tmp_path: Path) -> None:
    (tmp_path / "dist" / "sub").mkdir(parents=True)
    (tmp_path / "dist" / "a.bin").write_bytes(b"a")
    (tmp_path / "dist" / "sub" / "b.bin").write_bytes(b"b")
    (tmp_path / "report.xml").write_text("<r/>")
    outside = tmp_path.parent / f"outside-{os.getpid()}.txt"
    outside.write_text("no")
    try:
        (tmp_path / "link.txt").symlink_to(outside)
        files, missing = collect(tmp_path, ["dist", "report.xml", "dist/**", "link.txt", "nope/*"])
    finally:
        outside.unlink()
    rel = [f.relative_to(tmp_path.resolve()).as_posix() for f in files]
    assert rel == ["dist/a.bin", "dist/sub/b.bin", "report.xml"]
    assert missing == ["link.txt", "nope/*"]


def test_artifact_patterns_must_be_relative() -> None:
    assert validate_patterns("out/*") == ["out/*"]
    for bad in ["/etc/passwd", "../x", "C:/x", ""]:
        with pytest.raises(ArtifactError):
            validate_patterns([bad])


# --------------------------------------------------------------------------
# shell detection / routing / wire
# --------------------------------------------------------------------------

def test_detect_unix_shells() -> None:
    paths = {"bash": "/bin/bash", "zsh": "/bin/zsh"}
    shells = detect_shells("darwin", which=paths.get, exists=lambda p: p == "/bin/sh")
    assert shell_capabilities(shells) == [
        "shell.bash", "shell.zsh", "shell.posix", "shell.any",
    ]
    assert shells["any"].kind == "bash"
    no_bash = detect_shells("linux", which={"zsh": "/bin/zsh"}.get, exists=lambda p: False)
    assert no_bash["any"].kind == "zsh" and "posix" not in no_bash


def test_detect_windows_rejects_wsl_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SystemRoot", r"C:\Windows")
    monkeypatch.setenv("ProgramFiles", r"C:\Program Files")
    monkeypatch.setenv("ComSpec", r"C:\Windows\System32\cmd.exe")
    git_bash = os.path.join(r"C:\Program Files", "Git", "bin", "bash.exe")
    which = {"bash": r"C:\Windows\System32\bash.exe", "powershell": "powershell.exe"}.get
    existing = {git_bash, r"C:\Windows\System32\cmd.exe"}
    shells = detect_shells("win32", which=which, exists=lambda p: p in existing)
    assert shells["bash"].path == git_bash
    assert shells["cmd"].kind == "cmd"
    assert shells["any"].kind == "powershell"  # no pwsh → Windows PowerShell before cmd
    assert "posix" not in shells and "zsh" not in shells


def test_routing_and_policy() -> None:
    assert route_executor("shell.zsh") is execute_shell_job
    assert route_executor("shellcmd.bash") is not execute_shell_job
    for cap in ("shell.bash", "shell.any", "shell.pwsh"):
        assert is_sensitive_capability(cap)


def test_from_wire_accepts_string_payload() -> None:
    task = Task.from_wire({"id": {"cap": "shell.bash", "id": "1"},
                           "data": {"payload": "echo hi"}})
    assert task.payload == {"command": "echo hi"}


# --------------------------------------------------------------------------
# executor end to end (real shell, fake transport)
# --------------------------------------------------------------------------

class _Response:
    status_code = 200
    content = b""

    def raise_for_status(self) -> None:
        pass


class _FakeTransport:
    def __init__(self) -> None:
        self.logs: list[str] = []
        self.uploads: dict[str, bytes] = {}
        self.result: TaskResultReport | None = None
        self.cancel_at: float | None = None

    def is_cancelled(self) -> bool:
        return self.cancel_at is not None and time.monotonic() >= self.cancel_at

    def upload_file(self, bucket_uid: str, filename: str, content: bytes, content_type: str,
                    timeout: int = 300) -> str:
        self.uploads[filename] = content
        return f"uid-{len(self.uploads)}"

    def post_task_progress(self, task_id, report, timeout: int = 10) -> _Response:  # type: ignore[no-untyped-def]
        if report.log_update:
            self.logs.append(report.log_update)
        return _Response()

    def post_task_result(self, report, timeout: int = 60) -> _Response:  # type: ignore[no-untyped-def]
        self.result = report
        return _Response()

    @property
    def log(self) -> str:
        return "".join(self.logs)


def _run(tmp_path: Path, payload: dict[str, Any], *, cap: str = "shell.posix",
         bucket: str | None = None, timeout: int = 30,
         transport: _FakeTransport | None = None) -> tuple[_FakeTransport, Any]:
    transport = transport or _FakeTransport()
    job = prepare_shell_job(TaskId(id="task-1", cap=cap), cap, payload, bucket,
                            settings=_settings(tmp_path))
    try:
        run_prepared(transport, TaskId(id="task-1", cap=cap), job, timeout)  # type: ignore[arg-type]
    finally:
        job.cleanup()
    return transport, job


@unix_only
def test_success_streams_log_and_reports_output(tmp_path: Path) -> None:
    t, job = _run(tmp_path, {
        "command": "echo hello $GREETING; echo oops >&2; pwd; echo $OMQ_SHELL",
        "env": {"GREETING": "world"},
        "workspace": "w/${rand}",
    })
    assert t.result is not None and t.result.status.status == "success"
    out = t.result.output
    assert out["exit_code"] == 0
    assert out["stdout"].splitlines()[0] == "hello world"
    assert out["stdout"].splitlines()[2] == "posix"
    assert Path(out["stdout"].splitlines()[1]).resolve() == job.workspace.path
    assert out["stderr"] == "oops\n"
    assert "hello world" in t.log and "[stderr] oops" in t.log
    assert not job.workspace.path.exists()  # ${rand} → auto cleanup


@unix_only
def test_nonzero_exit_is_a_failure_with_output(tmp_path: Path) -> None:
    t, _ = _run(tmp_path, {"command": "echo partial; echo broke >&2; exit 3"})
    assert t.result is not None and t.result.status.status == "failure"
    assert t.result.output["exit_code"] == 3
    assert t.result.output["stdout"] == "partial\n"
    assert "broke" in t.result.status.data[0]


@unix_only
def test_multiline_script_and_strict_mode(tmp_path: Path) -> None:
    t, _ = _run(tmp_path, {"command": "a=1\necho \"a=$a\"\n", "strict": True})
    assert t.result is not None and t.result.output["stdout"] == "a=1\n"
    t, _ = _run(tmp_path, {"command": "false\necho not-reached\n", "strict": True})
    assert t.result is not None and t.result.output["exit_code"] != 0
    assert "not-reached" not in t.result.output["stdout"]


@unix_only
def test_credentials_are_masked_everywhere(tmp_path: Path) -> None:
    t, _ = _run(tmp_path, {
        "command": "echo token=$TOKEN; echo $TOKEN >&2; cat \"$KEYFILE\"; exit 1",
        "credentials": [
            {"name": "TOKEN", "type": "value", "value": "super-secret-1"},
            {"name": "KEYFILE", "type": "value", "value": "file-secret-2", "as": "file"},
        ],
    })
    assert t.result is not None
    blob = str(t.result.output) + t.log + str(t.result.status.data)
    assert "super-secret-1" not in blob and "file-secret-2" not in blob
    assert f"token={MASK}" in t.result.output["stdout"]


@unix_only
def test_input_files_and_artifacts(tmp_path: Path) -> None:
    staged = tmp_path / "root" / "art"  # what the pipeline's bucket download produces
    staged.mkdir(parents=True)
    (staged / "in.txt").write_text("input")
    t, job = _run(tmp_path, {
        "command": "mkdir -p out/sub && cp in.txt out/copy.txt && echo b > out/sub/b.txt",
        "workspace": "art",
        "artifacts": ["out/**", "missing.log"],
    }, bucket="bucket-1")
    assert t.result is not None and t.result.status.status == "success", t.result
    assert t.uploads == {"out/copy.txt": b"input", "out/sub/b.txt": b"b\n"}
    arts = t.result.output["artifacts"]
    assert [a["path"] for a in arts] == ["out/copy.txt", "out/sub/b.txt"]
    assert arts[0]["bucket_uid"] == "bucket-1" and arts[0]["size"] == 5
    assert t.result.output["artifacts_missing"] == ["missing.log"]
    assert job.workspace.path.exists()  # pre-existing dir: never deleted


@unix_only
def test_artifacts_skipped_on_failure_unless_always(tmp_path: Path) -> None:
    payload = {"command": "echo x > r.txt; exit 2", "artifacts": ["r.txt"]}
    t, _ = _run(tmp_path, payload, bucket="b")
    assert t.uploads == {} and t.result is not None and t.result.output["artifacts_skipped"]
    t, _ = _run(tmp_path, {**payload, "artifacts_when": "always"}, bucket="b")
    assert list(t.uploads) == ["r.txt"]


def test_prepare_validation_errors(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    tid = TaskId(id="1", cap="shell.posix")
    with pytest.raises(ShellJobError, match="command"):
        prepare_shell_job(tid, "shell.posix", {}, None, settings=settings)
    with pytest.raises(ShellJobError, match="output_bucket"):
        prepare_shell_job(tid, "shell.posix", {"command": "x", "artifacts": ["a"]}, None,
                          settings=settings)
    with pytest.raises(ShellJobError, match="not available"):
        prepare_shell_job(tid, "shell.nosuch", {"command": "x"}, None, settings=settings)
    with pytest.raises(ShellJobError, match="type"):
        prepare_shell_job(tid, "shell.posix",
                          {"command": "x", "credentials": [{"name": "A", "type": "bad"}]},
                          None, settings=settings)


@unix_only
def test_string_payload_still_runs(tmp_path: Path) -> None:
    t, _ = _run(tmp_path, "echo legacy")  # type: ignore[arg-type]
    assert t.result is not None and t.result.output["stdout"] == "legacy\n"


@unix_only
def test_timeout_kills_the_job(tmp_path: Path) -> None:
    start = time.monotonic()
    t, _ = _run(tmp_path, {"command": "echo started; sleep 30"}, timeout=1)
    assert time.monotonic() - start < 15
    assert t.result is not None and t.result.status.status == "failure"
    assert t.result.output["timed_out"] is True
    assert "started" in t.result.output["stdout"]


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@unix_only
def test_cancel_kills_background_children(tmp_path: Path) -> None:
    pidfile = tmp_path / "child.pid"
    transport = _FakeTransport()
    transport.cancel_at = time.monotonic() + 1.0
    t, _ = _run(tmp_path, {"command": f"sleep 60 & echo $! > {pidfile}; wait"},
                transport=transport)
    assert t.result is not None and t.result.status.status == "cancelled"
    pid = int(pidfile.read_text())
    deadline = time.monotonic() + 5
    while _alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(pid)


@unix_only
def test_background_child_is_reaped_after_success(tmp_path: Path) -> None:
    pidfile = tmp_path / "bg.pid"
    start = time.monotonic()
    t, _ = _run(tmp_path, {"command": f"sleep 60 & echo $! > {pidfile}; echo done"})
    assert time.monotonic() - start < 10  # did not wait for the orphan
    assert t.result is not None and t.result.output["stdout"] == "done\n"
    pid = int(pidfile.read_text())
    deadline = time.monotonic() + 5
    while _alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(pid)


@pytest.mark.skipif(shutil.which("zsh") is None, reason="zsh not installed")
def test_zsh_shell(tmp_path: Path) -> None:
    t, _ = _run(tmp_path, {"command": "echo $ZSH_VERSION | cut -c1"}, cap="shell.zsh")
    assert t.result is not None and t.result.output["shell"] == "zsh"
    assert t.result.output["stdout"].strip().isdigit()
