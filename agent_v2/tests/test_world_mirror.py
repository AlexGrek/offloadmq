"""Unit tests for world.mirror: licence gate, runtime/installer, scene conversion, executor,
orchestrator, REST and CLI.

The real WorldMirror venv, git and downloads are never touched.
"""
from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from offloadmq_agent.capabilities_sync import WORLD_MIRROR_CAP, check_world_mirror
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.exec.world import mirror as mirror_exec
from offloadmq_agent.exec.world import mirror_runtime as rt
from offloadmq_agent.exec.world import mirror_scene as scene
from offloadmq_agent.exec.world import sharp as sharp_exec
from offloadmq_agent.exec.world import sharp_runtime, splat
from offloadmq_agent.exec.world.mirror_runtime import MirrorPaths, ModelFile
from offloadmq_agent.pipeline import _takes_output_bucket
from offloadmq_agent.wire import TaskId
from offloadmq_core import mirror_install as mi

from test_world_splat import _FakeTransport

PAYLOADS = (b"{}", b"weights-bytes", b"sky")


@pytest.fixture()
def tiny_models(monkeypatch: pytest.MonkeyPatch) -> dict[str, bytes]:
    """Three small stand-ins for the model files, with real checksums."""
    files = tuple(
        ModelFile(f.rel, f"https://example/{Path(f.rel).name}", len(body), hashlib.sha256(body).hexdigest())
        for f, body in zip(rt.MODEL_FILES, PAYLOADS)
    )
    monkeypatch.setattr(rt, "MODEL_FILES", files)
    return {f.url: body for f, body in zip(files, PAYLOADS)}


def _fake_install(paths: MirrorPaths, manifest: bool = True) -> None:
    paths.python.parent.mkdir(parents=True, exist_ok=True)
    paths.python.write_bytes(b"")
    paths.pipeline.parent.mkdir(parents=True, exist_ok=True)
    paths.pipeline.write_text("pass\n")
    for spec, body in zip(rt.MODEL_FILES, PAYLOADS):
        paths.file(spec).parent.mkdir(parents=True, exist_ok=True)
        paths.file(spec).write_bytes(body)
    if manifest:
        paths.manifest.write_text(json.dumps({"revision": "abc123", "torch": "2.7.1", "device": "Fake GPU"}))


def _settings(root: Path, accepted: bool = True) -> dict[str, Any]:
    return {"mirror_dir": str(root), "mirror_license_accepted": accepted}


def _use_settings(monkeypatch: pytest.MonkeyPatch, settings: dict[str, Any]) -> None:
    monkeypatch.setattr(rt, "load_agent_settings", lambda: settings)


# --------------------------------------------------------------------------- runtime + licence


def test_off_until_installed_and_licence_accepted(tmp_path: Path, tiny_models: dict[str, bytes],
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "m"
    _use_settings(monkeypatch, _settings(root))
    assert check_world_mirror().caps == []
    _fake_install(MirrorPaths(root), manifest=False)
    assert check_world_mirror().caps == []  # files alone are not a verified install
    _fake_install(MirrorPaths(root))
    assert check_world_mirror().caps == [WORLD_MIRROR_CAP]

    _use_settings(monkeypatch, _settings(root, accepted=False))
    result = check_world_mirror()
    assert result.caps == [] and "licence" in result.reason
    assert rt.status(_settings(root, accepted=False)).installed
    # Only a real boolean accepts: a hand-edited string must not.
    assert not rt.license_accepted({"mirror_license_accepted": "false"})


def test_truncated_model_is_not_ready(tmp_path: Path, tiny_models: dict[str, bytes]) -> None:
    paths = MirrorPaths(tmp_path / "m")
    _fake_install(paths)
    paths.file(rt.MODEL_FILES[1]).write_bytes(b"x")
    st = rt.status(_settings(paths.root))
    assert not st.has_model and not st.ready and "model" in st.describe()


def test_default_directory() -> None:
    assert MirrorPaths.from_settings({}).root == rt.DEFAULT_ROOT


def test_routing() -> None:
    assert route_executor("world.mirror") is mirror_exec.execute_world_mirror
    assert _takes_output_bucket("world.mirror")


def test_runner_sources_compile() -> None:
    from offloadmq_agent.exec.world.mirror_runner import RUNNER_SOURCE, SHIM_SOURCE

    compile(RUNNER_SOURCE, "omq_mirror_runner.py", "exec")
    compile(SHIM_SOURCE, "shim.py", "exec")


# --------------------------------------------------------------------------- scene conversion


def _official(n: int = 4000, depth: tuple[float, float] = (0.3, 1.5)) -> dict[str, Any]:
    rng = np.random.default_rng(0)
    z = rng.uniform(*depth, n).astype(np.float32)
    cols: dict[str, Any] = {
        "x": (rng.uniform(-0.4, 0.4, n) * z).astype(np.float32),
        "y": (rng.uniform(-0.3, 0.3, n) * z).astype(np.float32),
        "z": z, "opacity": np.full(n, 0.75, np.float32),
    }
    for i in range(3):
        cols[f"f_dc_{i}"] = np.full(n, 0.2, np.float32)
        cols[f"scale_{i}"] = np.full(n, np.log(0.01), np.float32)
    for i in range(4):
        cols[f"rot_{i}"] = np.full(n, 1.0 if i == 0 else 0.0, np.float32)
    return cols


def test_scene_encodes_logit_opacity_and_applies_scale() -> None:
    splats = scene.scaled(scene.from_official(_official(), np.eye(4)), 10.0)
    cols = sharp_exec.read_vertex_ply(scene.write_ply(splats))
    np.testing.assert_allclose(cols["opacity"], np.log(3.0), rtol=1e-5)  # logit(0.75)
    np.testing.assert_allclose(cols["scale_0"], np.log(0.1), rtol=1e-5)
    np.testing.assert_allclose(cols["z"], _official()["z"] * 10, rtol=1e-5)


def test_scene_moves_into_the_camera_frame() -> None:
    c2w = np.eye(4)
    c2w[:3, :3] = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]]  # camera turned 90° about y
    c2w[:3, 3] = [1, 2, 3]
    cols = _official(1)
    world = c2w[:3, :3] @ np.array([0.1, 0.2, 2.0]) + c2w[:3, 3]
    cols["x"], cols["y"], cols["z"] = (np.array([v], np.float32) for v in world)
    splats = scene.from_official(cols, c2w)
    np.testing.assert_allclose(splats.xyz[0], [0.1, 0.2, 2.0], atol=1e-5)
    np.testing.assert_allclose(splats.quats[0], [np.sqrt(0.5), 0, -np.sqrt(0.5), 0], atol=1e-6)


def test_scene_rejects_empty_and_logit_input() -> None:
    with pytest.raises(ValueError):
        scene.from_official(_official(0), np.eye(4))
    bad = _official(3)
    bad["opacity"] = np.array([-2.0, 0.5, 3.0], np.float32)
    with pytest.raises(ValueError):
        scene.from_official(bad, np.eye(4))


def test_depth_comparison_recovers_the_scale() -> None:
    camera = scene.camera_from_intrinsics([[600, 0, 300], [0, 600, 225], [0, 0, 1]])
    assert (camera.width, camera.height) == (600, 450) and 52 < camera.hfov < 54
    splats = scene.from_official(_official(40000), np.eye(4))
    mine = scene.front_depth(splats.xyz, splats.opacity, camera)
    agreement = scene.compare_depth(mine * 7.0, mine)
    assert agreement is not None and agreement["scale"] == pytest.approx(7.0)
    assert agreement["median_rel_error"] < 1e-6
    assert scene.compare_depth(np.full((96, 96), np.nan), mine) is None
    assert scene.fallback_scale(splats) * np.median(splats.xyz[:, 2]) == pytest.approx(scene.FALLBACK_MEDIAN_M)


# --------------------------------------------------------------------------- installer


@pytest.fixture()
def fake_tools(tiny_models: dict[str, bytes], monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """uv, git, torch and the network, faked."""
    calls: dict[str, Any] = {"cmds": [], "downloads": [], "cuda": True}

    def run(cmd: list[str], paths: MirrorPaths, log: Any, timeout: float | None = None) -> str:
        calls["cmds"].append(cmd)
        if cmd[1] == "venv":
            paths.python.parent.mkdir(parents=True, exist_ok=True)
            paths.python.write_bytes(b"")
        return ""

    def fetch(paths: MirrorPaths, log: Any) -> None:
        paths.pipeline.parent.mkdir(parents=True, exist_ok=True)
        paths.pipeline.write_text("pass\n")

    def download(spec: ModelFile, dest: Path, log: Any, cancelled: Any) -> None:
        calls["downloads"].append(spec.rel)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(tiny_models[spec.url])

    monkeypatch.setattr(mi.shutil, "which", lambda name: f"/bin/{name}")
    monkeypatch.setattr(mi, "_run", run)
    monkeypatch.setattr(mi, "fetch_code", fetch)
    monkeypatch.setattr(mi, "code_ok", lambda p: p.pipeline.is_file())
    monkeypatch.setattr(mi, "_download", download)
    monkeypatch.setattr(mi, "_probe_runtime",
                        lambda p: {"torch": "2.7.1+cu128", "cuda": calls["cuda"], "device": "Fake GPU"})
    return calls


def test_install_needs_the_licence(tmp_path: Path, fake_tools: dict[str, Any]) -> None:
    paths = MirrorPaths(tmp_path / "m")
    with pytest.raises(mi.MirrorInstallError, match="European Union"):
        mi.install(paths, False, log=lambda _: None)
    assert not paths.root.exists() and not fake_tools["cmds"]


def test_install_verifies_skips_and_repairs(tmp_path: Path, fake_tools: dict[str, Any]) -> None:
    paths = MirrorPaths(tmp_path / "m")
    manifest = mi.install(paths, True, log=lambda _: None)
    assert manifest["revision"] == rt.CODE_REVISION and rt.status(_settings(paths.root)).ready
    assert len(fake_tools["downloads"]) == 3 and mi.doctor(paths, True)["ok"]

    mi.install(paths, True, log=lambda _: None)
    assert len(fake_tools["downloads"]) == 3  # verified files are kept

    paths.file(rt.MODEL_FILES[2]).write_bytes(b"bad")  # same size, wrong checksum
    report = mi.doctor(paths, True)
    assert not report["ok"] and report["action"] == "install"
    assert mi.repair(paths, True, log=lambda _: None)["ok"]
    assert fake_tools["downloads"][-1] == rt.MODEL_FILES[2].rel


def test_failed_install_is_not_advertised(tmp_path: Path, fake_tools: dict[str, Any]) -> None:
    paths = MirrorPaths(tmp_path / "m")
    mi.install(paths, True, log=lambda _: None)
    fake_tools["cuda"] = False
    with pytest.raises(mi.MirrorInstallError, match="CUDA"):
        mi.install(paths, True, log=lambda _: None)
    assert not paths.manifest.exists() and not rt.status(_settings(paths.root)).ready
    assert mi.doctor(paths, True)["action"] == "reinstall"


def test_install_cancel(tmp_path: Path, fake_tools: dict[str, Any]) -> None:
    with pytest.raises(mi.MirrorInstallError, match="cancelled"):
        mi.install(MirrorPaths(tmp_path / "m"), True, log=lambda _: None, cancelled=lambda: True)
    assert not fake_tools["downloads"]


def test_download_checks_the_checksum(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class Response:
        def __enter__(self) -> Response:
            return self

        def __exit__(self, *a: Any) -> None:
            return None

        def raise_for_status(self) -> None:
            return None

        def iter_content(self, chunk_size: int) -> list[bytes]:
            return [b"tampered"]

    monkeypatch.setattr(mi.requests, "get", lambda *a, **k: Response())
    spec = ModelFile("x.bin", "https://example/x.bin", 8, hashlib.sha256(b"original").hexdigest())
    dest = tmp_path / "x.bin"
    with pytest.raises(mi.MirrorInstallError, match="checksum"):
        mi._download(spec, dest, lambda _: None, lambda: False)
    assert not dest.exists() and not list(tmp_path.iterdir())


def test_code_digest_ignores_line_endings(tmp_path: Path) -> None:
    for name, newline in (("a", b"\n"), ("b", b"\r\n")):
        f = tmp_path / name / "hyworld2" / "x.py"
        f.parent.mkdir(parents=True)
        f.write_bytes(b"one" + newline + b"two" + newline)
    assert mi.code_digest(tmp_path / "a") == mi.code_digest(tmp_path / "b")


def test_uninstall_refuses_foreign_dirs_and_keeps_other_files(tmp_path: Path,
                                                              tiny_models: dict[str, bytes]) -> None:
    foreign = MirrorPaths(tmp_path / "docs")
    foreign.venv.mkdir(parents=True)
    (foreign.venv / "important.txt").write_text("keep")
    with pytest.raises(mi.MirrorInstallError):
        mi.uninstall(foreign)
    assert (foreign.venv / "important.txt").exists()

    paths = MirrorPaths(tmp_path / "m")
    _fake_install(paths)
    (paths.root / "notes.txt").write_text("mine")
    readonly = paths.source / "object"
    readonly.write_bytes(b"git")
    readonly.chmod(0o400)
    mi.uninstall(paths, remove_models=False, log=lambda _: None)
    assert not paths.venv.exists() and not paths.source.exists() and not paths.manifest.exists()
    assert paths.file(rt.MODEL_FILES[1]).exists()
    mi.uninstall(paths, log=lambda _: None)
    assert not paths.file(rt.MODEL_FILES[1]).exists() and (paths.root / "notes.txt").exists()


# --------------------------------------------------------------------------- executor


def _ply(cols: dict[str, Any]) -> bytes:
    header = "\n".join(["ply", "format binary_little_endian 1.0", f"element vertex {len(cols['x'])}"]
                       + [f"property float {n}" for n in cols] + ["end_header", ""])
    return header.encode() + np.stack([cols[n] for n in cols], 1).astype("<f4").tobytes()


@pytest.fixture()
def fake_run(tmp_path: Path, tiny_models: dict[str, bytes], monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Both runners faked: WorldMirror writes a scene 7× smaller than SHARP's."""
    root = tmp_path / "mirror"
    _fake_install(MirrorPaths(root))
    _use_settings(monkeypatch, _settings(root))
    monkeypatch.setattr(sharp_exec, "_free_comfy_vram", lambda *a: None)
    calls: dict[str, Any] = {"sharp_ready": True, "sharp_runs": 0, "ollama_freed": 0, "timeouts": []}
    monkeypatch.setattr(mirror_exec, "_free_ollama_vram",
                        lambda *a: calls.__setitem__("ollama_freed", calls["ollama_freed"] + 1))
    near = _official(40000)

    def run_runtime(transport: Any, task_id: Any, cmd: list[str], cwd: Path, timeout: int | None,
                    label: str) -> None:
        calls["cmd"] = cmd
        calls["timeouts"].append(timeout)
        out = Path(cmd[cmd.index("--out-dir") + 1])
        (out / "official").mkdir(parents=True)
        (out / "official" / "gaussians.ply").write_bytes(_ply(near))
        (out / "meta.json").write_text(json.dumps({
            "extrinsics": np.eye(4).tolist(), "intrinsics": [[600, 0, 300], [0, 600, 225], [0, 0, 1]],
            "gpu": "Fake GPU", "torch": "2.7.1", "peak_vram_gib": 7.8, "timings": {"predict_s": 0.4},
        }))

    def run_sharp(*a: Any, **k: Any) -> tuple[dict[str, Any], bytes]:
        calls["sharp_runs"] += 1
        calls["timeouts"].append(a[5])
        if calls.get("sharp_error"):
            raise RuntimeError("SHARP exited with 1:\nout of memory")
        n = len(near["x"])
        xyz = np.stack([near["x"], near["y"], near["z"]], 1) * 7
        ply = splat.write_ply(xyz, np.full((n, 3), 0.5, np.float32), np.full((n, 3), 0.02, np.float32),
                              np.tile([1, 0, 0, 0], (n, 1)).astype(np.float32), np.full(n, 0.9, np.float32))
        return {"width": 600, "height": 450, "focal_px": 600.0}, ply

    class Status:
        @property
        def ready(self) -> bool:
            return bool(calls["sharp_ready"])

        paths = None

    monkeypatch.setattr(sharp_runtime, "status", lambda paths=None: Status())
    monkeypatch.setattr(sharp_exec, "run_runtime", run_runtime)
    monkeypatch.setattr(sharp_exec, "run_sharp", run_sharp)
    return calls


def _run(tmp_path: Path, payload: dict[str, Any]) -> _FakeTransport:
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    Image.new("RGB", (320, 240), (90, 120, 60)).save(data / "in_1.png")
    t = _FakeTransport()
    mirror_exec.execute_world_mirror(
        t,  # type: ignore[arg-type]
        TaskId(id="task-1", cap="world.mirror"), "world.mirror", payload, data, output_bucket="out",
    )
    return t


def test_executor_takes_its_scale_from_sharp(tmp_path: Path, fake_run: dict[str, Any]) -> None:
    t = _run(tmp_path, {"input_image": "in_1.png", "max_width": 1024})
    assert t.result is not None and t.result.status.status == "success", t.result
    out = t.result.output
    assert "--cleanup" not in fake_run["cmd"] and fake_run["sharp_runs"] == 1
    assert fake_run["timeouts"] == [None, None]  # neither run has a time limit
    assert fake_run["ollama_freed"] == 1  # on by default
    assert out["generator"] == "hy-worldmirror-2.0" and out["mode"] == "perspective"
    assert out["settings"]["scale_source"] == "sharp"
    assert out["settings"]["scale"] == pytest.approx(7.0, rel=0.01)
    assert out["splat_count"] == 40000 and out["runtime"]["revision"] == "abc123"
    assert "United Kingdom" in out["license"]
    assert set(t.uploads) == {"scene.ply", "preview.png"}
    z = sharp_exec.read_vertex_ply(t.uploads["scene.ply"])["z"]
    assert 2.0 < float(z.min()) and float(z.max()) < 10.6
    json.dumps(out)


@pytest.mark.parametrize("why", ["missing", "broken"])
def test_executor_estimates_scale_without_sharp(tmp_path: Path, fake_run: dict[str, Any], why: str) -> None:
    fake_run["sharp_ready"] = why != "missing"
    fake_run["sharp_error"] = why == "broken"
    t = _run(tmp_path, {"input_image": "in_1.png", "cleanup": True})
    assert t.result is not None and t.result.status.status == "success", t.result
    assert "--cleanup" in fake_run["cmd"]
    out = t.result.output
    assert out["settings"]["scale_source"] == "median" and out["scale_agreement"] is None
    z = sharp_exec.read_vertex_ply(t.uploads["scene.ply"])["z"]
    assert float(np.median(z)) == pytest.approx(scene.FALLBACK_MEDIAN_M, rel=1e-3)


@pytest.mark.parametrize("payload", [{"input_image": "in_1.png", "mode": "pano"},
                                     {"input_image": "in_1.png", "cleanup": "yes"},
                                     {}])
def test_executor_rejects_bad_payloads(tmp_path: Path, fake_run: dict[str, Any], payload: dict[str, Any]) -> None:
    t = _run(tmp_path, payload)
    assert t.result is not None and t.result.status.status != "success"
    assert "cmd" not in fake_run


def test_executor_refuses_without_licence(tmp_path: Path, fake_run: dict[str, Any],
                                          monkeypatch: pytest.MonkeyPatch) -> None:
    _use_settings(monkeypatch, _settings(tmp_path / "mirror", accepted=False))
    t = _run(tmp_path, {"input_image": "in_1.png"})
    assert t.result is not None and t.result.status.status != "success"
    assert "licence" in json.dumps(t.result.output) and "cmd" not in fake_run


def test_ollama_unloading_can_be_turned_off(tmp_path: Path, fake_run: dict[str, Any],
                                            monkeypatch: pytest.MonkeyPatch) -> None:
    assert rt.free_ollama({}) and rt.free_ollama({"mirror_free_ollama": True})
    _use_settings(monkeypatch, {**_settings(tmp_path / "mirror"), "mirror_free_ollama": False})
    t = _run(tmp_path, {"input_image": "in_1.png"})
    assert t.result is not None and t.result.status.status == "success", t.result
    assert fake_run["ollama_freed"] == 0


def test_ollama_is_asked_to_unload(monkeypatch: pytest.MonkeyPatch) -> None:
    loaded = [{"model": "qwen:8b"}]
    posted: list[dict[str, Any]] = []

    class Reply:
        def json(self) -> dict[str, Any]:
            return {"models": list(loaded)}

    def post(url: str, json: dict[str, Any], timeout: int) -> None:
        posted.append(json)
        loaded.clear()

    monkeypatch.setattr(mirror_exec.requests, "get", lambda *a, **k: Reply())
    monkeypatch.setattr(mirror_exec.requests, "post", post)
    monkeypatch.setattr(mirror_exec, "report_progress", lambda *a, **k: None)
    mirror_exec._free_ollama_vram(None, TaskId(id="t", cap="world.mirror"))  # type: ignore[arg-type]
    assert posted == [{"model": "qwen:8b", "keep_alive": 0}]


# --------------------------------------------------------------------------- orchestrator / REST / CLI


@pytest.fixture()
def orch(tmp_path: Path, fake_tools: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> Any:
    from offloadmq_core.orchestrator import Orchestrator

    o = Orchestrator(settings_path=tmp_path / "agent.json")
    o.update_settings(mirror_dir=str(tmp_path / "m"))
    o.start_background_scan = lambda: None  # type: ignore[method-assign]
    return o


def _wait_job(o: Any) -> dict[str, Any]:
    done = threading.Event()
    for _ in range(200):
        snap: dict[str, Any] = o.get_mirror_status()["job"]
        if snap["state"] != "running":
            assert snap["state"] != "failed", snap["error"]
            return snap
        done.wait(0.05)
    raise AssertionError("job did not finish")


def test_orchestrator_licence_gate_and_lifecycle(orch: Any) -> None:
    assert not orch.get_mirror_status()["license_accepted"]
    for start in (orch.start_mirror_install, orch.start_mirror_repair):
        with pytest.raises(mi.MirrorInstallError, match="licence"):
            start()
    orch.update_mirror_settings(license_accepted=True)
    orch.start_mirror_install()
    assert _wait_job(orch)["state"] == "succeeded"
    assert orch.get_mirror_status()["ready"] and orch.run_mirror_doctor()["ok"]
    st = orch.update_mirror_settings(license_accepted=False)  # False must persist, not be ignored
    assert st["installed"] and not st["ready"]
    orch.start_mirror_uninstall()
    assert _wait_job(orch)["state"] == "succeeded" and not orch.get_mirror_status()["installed"]


def test_settings_survive_save(tmp_path: Path) -> None:
    from offloadmq_core.settings import Settings, load_settings, save_settings

    path = tmp_path / "s.json"
    assert Settings().mirror_license_accepted is False
    save_settings(Settings(mirror_dir=" E:/mirror ", mirror_license_accepted=True), path)
    s = load_settings(path)
    assert (s.mirror_dir, s.mirror_license_accepted) == ("E:/mirror", True)
    assert s.mirror_free_ollama is True
    save_settings(Settings(mirror_free_ollama=False), path)
    assert load_settings(path).mirror_free_ollama is False


def test_ui_routes(orch: Any) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from ui_server.api import create_router

    app = FastAPI()
    app.include_router(create_router(orch))
    client = TestClient(app)
    assert client.get("/api/mirror/status").json()["license_accepted"] is False
    assert client.post("/api/mirror/install", json={}).status_code == 409
    r = client.post("/api/mirror/settings", json={"mirror_license_accepted": True})
    assert r.status_code == 200 and r.json()["license_accepted"]
    assert r.json()["settings"]["mirror_free_ollama"] is True
    r = client.post("/api/mirror/settings", json={"mirror_free_ollama": False})
    assert r.json()["settings"]["mirror_free_ollama"] is False and r.json()["license_accepted"]
    assert client.post("/api/mirror/install", json={}).status_code == 200
    assert _wait_job(orch)["state"] == "succeeded"
    assert client.post("/api/mirror/doctor").json()["ok"]
    assert client.post("/api/mirror/cancel").status_code == 200
    assert client.post("/api/mirror/uninstall", json={"remove_models": False}).status_code == 200
    assert _wait_job(orch)["state"] == "succeeded"


def test_cli(orch: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from typer.testing import CliRunner

    from cli_manager import main as cli

    monkeypatch.setattr(cli, "_orch", lambda: orch)
    runner = CliRunner()
    assert runner.invoke(cli.app, ["mirror", "status"]).exit_code == 1
    r = runner.invoke(cli.app, ["mirror", "install"])
    assert r.exit_code == 1 and "accept-license" in r.output
    assert runner.invoke(cli.app, ["mirror", "doctor", "--fix"]).exit_code == 1
    r = runner.invoke(cli.app, ["mirror", "install", "--accept-license"])
    assert r.exit_code == 0, r.output
    assert runner.invoke(cli.app, ["mirror", "status"]).exit_code == 0
    assert runner.invoke(cli.app, ["mirror", "doctor"]).exit_code == 0
    assert runner.invoke(cli.app, ["mirror", "config", "--revoke-license"]).exit_code == 1
    assert orch.get_settings().mirror_license_accepted is False
    assert runner.invoke(cli.app, ["mirror", "config", "--keep-ollama"]).exit_code == 1
    assert orch.get_settings().mirror_free_ollama is False
    assert runner.invoke(cli.app, ["mirror", "uninstall", "--yes"]).exit_code == 0
