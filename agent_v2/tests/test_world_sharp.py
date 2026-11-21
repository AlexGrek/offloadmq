"""Unit tests for world.sharp: runtime location/status, installer helpers, doctor and executor.

The real SHARP venv is never touched: the runner subprocess is faked.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from offloadmq_agent.capabilities_sync import WORLD_SHARP_CAP, check_world_sharp
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.exec.world import sharp as sharp_exec
from offloadmq_agent.exec.world import sharp_runtime as rt
from offloadmq_agent.exec.world import splat
from offloadmq_agent.exec.world.sharp_runtime import SharpPaths
from offloadmq_agent.pipeline import _takes_output_bucket
from offloadmq_agent.wire import TaskId
from offloadmq_core import sharp_install as si

from test_world_splat import _FakeTransport


@pytest.fixture()
def small_model(monkeypatch: pytest.MonkeyPatch) -> int:
    monkeypatch.setattr(rt, "CHECKPOINT_BYTES", 16)
    return 16


def _fake_install(paths: SharpPaths, model_bytes: int = 16, manifest: dict[str, Any] | None = None) -> None:
    paths.cli.parent.mkdir(parents=True, exist_ok=True)
    paths.python.write_bytes(b"")
    paths.cli.write_bytes(b"")
    paths.models.mkdir(parents=True, exist_ok=True)
    paths.checkpoint.write_bytes(b"x" * model_bytes)
    if manifest is not None:
        paths.manifest.write_text(json.dumps(manifest), encoding="utf-8")


# --------------------------------------------------------------------------- runtime


def test_paths_default_and_configured(tmp_path: Path) -> None:
    d = SharpPaths.from_settings({})
    assert d.venv == rt.DEFAULT_ROOT / "venv" and d.models == rt.DEFAULT_ROOT / "models"
    c = SharpPaths.from_settings({"sharp_venv_dir": f" {tmp_path / 'v'} ", "sharp_models_dir": str(tmp_path / "m")})
    assert c.venv == tmp_path / "v" and c.checkpoint == tmp_path / "m" / rt.CHECKPOINT_NAME
    assert c.manifest.parent == c.venv and c.source_copy.parent == c.venv


def test_status_requires_venv_and_exact_model(tmp_path: Path, small_model: int) -> None:
    paths = SharpPaths(tmp_path / "v", tmp_path / "m")
    assert not rt.status(paths).ready
    _fake_install(paths, model_bytes=small_model - 1)
    st = rt.status(paths)
    assert st.has_cli and not st.has_checkpoint and not st.ready  # truncated download
    paths.checkpoint.write_bytes(b"x" * small_model)
    st = rt.status(paths)
    assert st.ready and "unverified" in st.describe()
    assert st.to_dict()["venv_dir"] == str(paths.venv)


def test_find_source_is_the_submodule() -> None:
    src = rt.find_source()
    assert src is not None and (src / "src" / "sharp" / "cli" / "predict.py").is_file()


def test_capability_probe_follows_install(tmp_path: Path, small_model: int,
                                          monkeypatch: pytest.MonkeyPatch) -> None:
    paths = SharpPaths(tmp_path / "v", tmp_path / "m")
    monkeypatch.setattr(rt.SharpPaths, "from_settings", classmethod(lambda cls, s=None: paths))
    assert check_world_sharp().caps == []
    _fake_install(paths, manifest={"revision": "abc"})
    r = check_world_sharp()
    assert r.ok and r.caps == [WORLD_SHARP_CAP]


def test_routing() -> None:
    assert route_executor("world.sharp") is sharp_exec.execute_world_sharp
    assert route_executor("world.splat") is not sharp_exec.execute_world_sharp
    assert _takes_output_bucket("world.sharp")


# --------------------------------------------------------------------------- installer


def test_parse_requirements_splits_torch_stack() -> None:
    text = """# uv compile
-e .
torch==2.8.0
    # via sharp
torchvision==0.23.0
triton==3.4.0 ; platform_machine == 'x86_64'
nvidia-cudnn-cu12==9.10 ; sys_platform == 'linux'
numpy==2.3.3
colorama==0.4.6 ; sys_platform == 'win32'
"""
    torch_pins, constraints = si.parse_requirements(text)
    assert torch_pins == {"torch": "torch==2.8.0", "torchvision": "torchvision==0.23.0"}
    assert constraints == ["numpy==2.3.3", "colorama==0.4.6 ; sys_platform == 'win32'"]


def test_resolve_torch_index(monkeypatch: pytest.MonkeyPatch) -> None:
    assert si.resolve_torch_index("cuda") == si.CUDA_INDEX
    assert si.resolve_torch_index("cpu") == si.CPU_INDEX
    assert si.resolve_torch_index("pypi") is None
    assert si.resolve_torch_index("https://example/whl") == "https://example/whl"
    with pytest.raises(si.SharpInstallError):
        si.resolve_torch_index("cuda13")
    monkeypatch.setattr(si.sys, "platform", "linux")
    monkeypatch.setattr(si.shutil, "which", lambda name: None)
    assert si.resolve_torch_index("auto") == si.CPU_INDEX


def test_uninstall_refuses_foreign_dirs_and_removes_ours(tmp_path: Path, small_model: int) -> None:
    foreign = SharpPaths(tmp_path / "docs", tmp_path / "m")
    foreign.venv.mkdir()
    (foreign.venv / "important.txt").write_text("keep")
    with pytest.raises(si.SharpInstallError):
        si.uninstall(foreign)
    assert (foreign.venv / "important.txt").exists()

    paths = SharpPaths(tmp_path / "v", tmp_path / "m2")
    _fake_install(paths)
    si.uninstall(paths, remove_models=False, log=lambda _: None)
    assert not paths.venv.exists() and paths.checkpoint.exists()
    si.uninstall(paths, remove_models=True, log=lambda _: None)
    assert not paths.checkpoint.exists() and paths.models.exists()  # the chosen dir itself stays


def test_doctor_reports_missing_pieces(tmp_path: Path, small_model: int) -> None:
    report = si.doctor(SharpPaths(tmp_path / "v", tmp_path / "m"), "cpu")
    by = {c["name"]: c for c in report["checks"]}
    assert not report["ok"] and report["action"] == "install"
    assert by["source"]["ok"] and not by["venv"]["ok"] and not by["model"]["ok"]


def test_doctor_flags_broken_torch_for_rebuild(tmp_path: Path, small_model: int,
                                              monkeypatch: pytest.MonkeyPatch) -> None:
    paths = SharpPaths(tmp_path / "v", tmp_path / "m")
    src = rt.find_source()
    assert src is not None
    _fake_install(paths, manifest={"source_digest": si.source_digest(src)})

    def broken(_paths: SharpPaths) -> dict[str, Any]:
        raise si.SharpInstallError("import torch/sharp failed: DLL load failed")

    monkeypatch.setattr(si, "_probe_runtime", broken)
    report = si.doctor(paths, "cpu")
    assert report["action"] == "reinstall"

    monkeypatch.setattr(si, "_probe_runtime", lambda p: {"torch": "2.8.0+cpu", "cuda": False})
    assert si.doctor(paths, "cpu")["ok"]
    cuda_wanted = si.doctor(paths, "cuda")  # a CPU build where CUDA was asked for
    assert cuda_wanted["action"] == "reinstall"


def test_install_job_runs_once_and_records_failure() -> None:
    import threading

    job = si.SharpInstallJob()
    gate = threading.Event()
    done = threading.Event()

    def slow(log: Any, cancelled: Any) -> None:
        log("working")
        gate.wait(5)
        raise si.SharpInstallError("boom")

    job.start("install", slow, on_done=lambda ok: done.set())
    with pytest.raises(si.SharpInstallError):
        job.start("install", slow)
    gate.set()
    assert done.wait(5)
    snap = job.snapshot()
    assert snap["state"] == "failed" and snap["error"] == "boom" and "working" in snap["log"]


# --------------------------------------------------------------------------- executor


def test_read_vertex_ply_roundtrip() -> None:
    xyz = np.array([[0, 0, 1], [1, 2, 3]], np.float32)
    ply = splat.write_ply(xyz, np.full((2, 3), 0.5, np.float32), np.full((2, 3), 0.1, np.float32),
                          np.tile([1, 0, 0, 0], (2, 1)).astype(np.float32), np.array([0.5, 0.9], np.float32))
    cols = sharp_exec.read_vertex_ply(ply + b"trailing element bytes")
    np.testing.assert_allclose(np.stack([cols["x"], cols["y"], cols["z"]], 1), xyz)
    with pytest.raises(ValueError):
        sharp_exec.read_vertex_ply(b"not a ply")


@pytest.fixture()
def fake_sharp(tmp_path: Path, small_model: int, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    paths = SharpPaths(tmp_path / "venv", tmp_path / "models")
    _fake_install(paths, manifest={"revision": "abc123"})
    monkeypatch.setattr(rt.SharpPaths, "from_settings", classmethod(lambda cls, s=None: paths))
    monkeypatch.setattr(sharp_exec, "_free_comfy_vram", lambda *a: None)
    calls: dict[str, Any] = {}

    def run_process(cmd: list[str], cwd: Path, env: dict[str, str], stdin: bytes, tick: Any,
                    output: dict[str, Any], prefix: str = "") -> int:
        calls["cmd"] = cmd
        tick()
        out = Path(cmd[cmd.index("--out-dir") + 1])
        out.mkdir(parents=True)
        n = 200
        rng = np.random.default_rng(0)
        xyz = np.stack([rng.uniform(-1, 1, n), rng.uniform(-1, 1, n), rng.uniform(2, 8, n)], 1).astype(np.float32)
        ply = splat.write_ply(xyz, rng.uniform(0, 1, (n, 3)).astype(np.float32),
                              np.full((n, 3), 0.02, np.float32), np.tile([1, 0, 0, 0], (n, 1)).astype(np.float32),
                              np.full(n, 0.9, np.float32))
        (out / "scene.ply").write_bytes(ply)
        hfov = float(cmd[cmd.index("--hfov") + 1]) if "--hfov" in cmd else 60.0
        (out / "meta.json").write_text(json.dumps({
            "width": 320, "height": 240, "focal_px": 277.1, "hfov": hfov,
            "focal_source": "hfov" if "--hfov" in cmd else "exif_or_default", "count": n,
            "device": "cuda", "gpu": "Fake GPU", "peak_vram_gib": 6.9, "torch": "2.8.0",
            "timings": {"load_s": 1.0, "predict_s": 0.5, "save_s": 0.1},
        }))
        return 0

    monkeypatch.setattr(sharp_exec, "run_process", run_process)
    return calls


def _run(tmp_path: Path, payload: dict[str, Any]) -> _FakeTransport:
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    Image.new("RGB", (320, 240), (90, 120, 60)).save(data / "in_1.png")
    t = _FakeTransport()
    sharp_exec.execute_world_sharp(
        t,  # type: ignore[arg-type]
        TaskId(id="task-1", cap="world.sharp"), "world.sharp", payload, data, output_bucket="out",
    )
    return t


def test_executor_end_to_end(tmp_path: Path, fake_sharp: dict[str, Any]) -> None:
    t = _run(tmp_path, {"input_image": "in_1.png", "hfov": 55, "max_width": 1024})
    assert t.result is not None and t.result.status.status == "success", t.result
    out = t.result.output
    cmd = fake_sharp["cmd"]
    assert cmd[0] == str(rt.SharpPaths.from_settings().python) and cmd[cmd.index("--hfov") + 1] == "55"
    assert out["generator"] == "apple-sharp" and out["mode"] == "perspective"
    assert out["splat_count"] == 200 and out["splats_bg"] == 0
    assert out["settings"]["hfov"] == 55 and out["runtime"]["revision"] == "abc123"
    assert set(t.uploads) == {"scene.ply", "preview.png"}
    assert out["ply"]["bytes"] == len(t.uploads["scene.ply"]) and out["preview"]["file_uid"] == "uid-preview.png"
    assert out["depth_range_m"][0] >= 2 and out["depth_range_m"][1] <= 8
    json.dumps(out)


def test_executor_defaults_focal_and_rejects_pano(tmp_path: Path, fake_sharp: dict[str, Any]) -> None:
    t = _run(tmp_path, {"input_image": "in_1.png"})
    assert t.result is not None and t.result.status.status == "success"
    assert "--hfov" not in fake_sharp["cmd"]
    assert t.result.output["settings"]["focal_source"] == "exif_or_default"

    t = _run(tmp_path, {"input_image": "in_1.png", "mode": "pano"})
    assert t.result is not None and t.result.status.status != "success"


def test_executor_fails_cleanly_when_not_installed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths = SharpPaths(tmp_path / "none", tmp_path / "none-m")
    monkeypatch.setattr(rt.SharpPaths, "from_settings", classmethod(lambda cls, s=None: paths))
    t = _run(tmp_path, {"input_image": "in_1.png"})
    assert t.result is not None and t.result.status.status != "success"
    assert "omq sharp install" in json.dumps(t.result.output)


def test_runner_source_compiles() -> None:
    from offloadmq_agent.exec.world.sharp_runner import RUNNER_SOURCE

    compile(RUNNER_SOURCE, "omq_sharp_runner.py", "exec")
