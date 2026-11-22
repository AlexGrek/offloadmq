"""Unit tests for onnx.bgremove.* management: settings → device/providers, status,
install / doctor / repair / uninstall, capability gating, orchestrator + CLI.

No real model is downloaded: ``requests.get`` is faked and the registry entries
are shrunk to tiny payloads with matching md5/size.
"""
from __future__ import annotations

import hashlib
import io
import threading
from pathlib import Path
from typing import Any

import pytest

from offloadmq_agent import onnx_models
from offloadmq_agent.exec import bgremove, bgremove_runtime as rt
from offloadmq_core import bgremove_install as bi

PAYLOAD = b"o" * (onnx_models._MIN_VALID_ONNX_BYTES + 10)


class _FakeResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body
        self.headers = {"content-length": str(len(body))}

    def __enter__(self) -> _FakeResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        pass

    def raise_for_status(self) -> None:
        pass

    def iter_content(self, chunk_size: int) -> Any:
        buf = io.BytesIO(self._body)
        while chunk := buf.read(chunk_size):
            yield chunk


@pytest.fixture(autouse=True)
def cpu_only_onnxruntime(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pretend onnxruntime is the CPU build, whatever is installed on the test box."""
    import onnxruntime as ort

    monkeypatch.setattr(ort, "get_available_providers", lambda: ["CPUExecutionProvider"])


@pytest.fixture()
def small_registry(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every bgremove model downloads PAYLOAD (md5/size pinned to it)."""
    md5 = hashlib.md5(PAYLOAD).hexdigest()
    for name in rt.model_names():
        meta = dict(onnx_models.ONNX_MODEL_REGISTRY[name])
        meta.update(md5=md5, size_bytes=len(PAYLOAD))
        monkeypatch.setitem(onnx_models.ONNX_MODEL_REGISTRY, name, meta)
    calls: list[str] = []

    def fake_get(url: str, **_: Any) -> _FakeResponse:
        calls.append(url)
        return _FakeResponse(PAYLOAD)

    monkeypatch.setattr(onnx_models.requests, "get", fake_get)
    return calls


@pytest.fixture()
def settings(tmp_path: Path) -> dict[str, Any]:
    return {"onnx_models_dir": str(tmp_path / "models"), "bgremove_device": "cpu"}


def _model_file(settings: dict[str, Any], name: str) -> Path:
    return Path(settings["onnx_models_dir"]) / str(onnx_models.ONNX_MODEL_REGISTRY[name]["filename"])


# --------------------------------------------------------------------------- runtime


def test_resolve_providers() -> None:
    cpu_only = ["CPUExecutionProvider"]
    gpu = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert rt.resolve_providers("auto", cpu_only) == ["CPUExecutionProvider"]
    assert rt.resolve_providers("auto", ["DmlExecutionProvider", *cpu_only]) == ["DmlExecutionProvider", "CPUExecutionProvider"]
    assert rt.resolve_providers("cuda", gpu) == gpu
    assert rt.resolve_providers("cpu", gpu) == ["CPUExecutionProvider"]
    with pytest.raises(rt.BgRemoveConfigError, match="only provides"):
        rt.resolve_providers("cuda", cpu_only)
    with pytest.raises(rt.BgRemoveConfigError):
        rt.validate_device("tpu")
    assert rt.validate_device(" CUDA ") == "cuda"


def test_config_from_settings_defaults_and_values() -> None:
    d = rt.BgRemoveConfig.from_settings({})
    assert (d.device, d.threads, d.keep_loaded) == ("auto", 0, True)
    c = rt.BgRemoveConfig.from_settings({"bgremove_device": "CPU", "bgremove_threads": 4, "bgremove_keep_loaded": False})
    assert (c.device, c.threads, c.keep_loaded) == ("cpu", 4, False)


def test_normalize_model_accepts_short_full_and_capability() -> None:
    full = "bgremove-birefnet-lite"
    assert rt.normalize_model("birefnet-lite") == full
    assert rt.normalize_model(full) == full
    assert rt.normalize_model("onnx.bgremove.birefnet-lite[x]") == full
    with pytest.raises(rt.BgRemoveConfigError, match="known"):
        rt.normalize_model("nudenet")  # not a bgremove model


def test_status_reports_models_dir_device_and_partial(settings: dict[str, Any], small_registry: list[str]) -> None:
    st = rt.status(settings)
    assert not st["ready"] and "omq bgremove install" in st["summary"]
    assert st["models_dir"] == settings["onnx_models_dir"] and st["providers"] == ["CPUExecutionProvider"]
    assert {m["short"] for m in st["models"]} == {"birefnet-general", "birefnet-portrait", "birefnet-lite"}

    f = _model_file(settings, rt.DEFAULT_MODEL)
    f.parent.mkdir(parents=True)
    f.write_bytes(PAYLOAD[:-1])  # truncated
    general = next(m for m in rt.status(settings)["models"] if m["default"])
    assert general["present"] and not general["installed"]

    f.write_bytes(PAYLOAD)
    st = rt.status(settings)
    assert st["ready"] and "birefnet-general" in st["summary"]

    bad = rt.status({**settings, "bgremove_device": "cuda"})  # CPU-only onnxruntime here
    assert not bad["ready"] and bad["device_error"]


# --------------------------------------------------------------------------- install / doctor


def test_install_default_then_skip_then_force(settings: dict[str, Any], small_registry: list[str]) -> None:
    lines: list[str] = []
    paths = bi.install(None, settings, lines.append)
    assert paths == [str(_model_file(settings, rt.DEFAULT_MODEL))] and len(small_registry) == 1
    assert any("100%" in line for line in lines)
    assert sum("Downloading 'bgremove" in line and "%" in line for line in lines) <= 11  # 10% steps

    bi.install(["birefnet-general"], settings, lines.append)
    assert len(small_registry) == 1  # already there
    bi.install(["birefnet-general"], settings, lines.append, force=True)
    assert len(small_registry) == 2


def test_install_rejects_unknown_and_honours_cancel(settings: dict[str, Any], small_registry: list[str]) -> None:
    with pytest.raises(bi.BgRemoveInstallError, match="unknown"):
        bi.install(["rmbg"], settings)
    with pytest.raises(bi.BgRemoveInstallError, match="cancelled"):
        bi.install(None, settings, cancelled=lambda: True)
    f = _model_file(settings, rt.DEFAULT_MODEL)
    assert not f.exists() and not f.with_suffix(".download").exists()


def test_prepare_model_cancel_mid_download_is_not_retried(settings: dict[str, Any],
                                                          small_registry: list[str]) -> None:
    calls = iter([False, True])  # cancel on the second chunk
    with pytest.raises(onnx_models.DownloadCancelled):
        onnx_models.prepare_model(rt.DEFAULT_MODEL, settings=settings, cancelled=lambda: next(calls, True))
    assert len(small_registry) == 1


def test_doctor_install_redownload_and_repair(settings: dict[str, Any], small_registry: list[str]) -> None:
    report = bi.doctor(settings)
    by = {c["name"]: c for c in report["checks"]}
    assert report["action"] == "install" and not by["installed"]["ok"]
    assert by["onnxruntime"]["ok"] and by["device"]["ok"] and by["models dir"]["ok"]

    bi.repair(settings, log=lambda _: None)
    assert bi.doctor(settings)["ok"]

    _model_file(settings, rt.DEFAULT_MODEL).write_bytes(b"x" * len(PAYLOAD))  # same size, wrong md5
    report = bi.doctor(settings)
    assert report["action"] == "redownload" and report["redownload"] == [rt.DEFAULT_MODEL]
    after = bi.repair(settings, log=lambda _: None)
    assert after["ok"] and _model_file(settings, rt.DEFAULT_MODEL).read_bytes() == PAYLOAD


def test_doctor_flags_device_but_cannot_repair_it(settings: dict[str, Any], small_registry: list[str]) -> None:
    bi.install(None, settings, lambda _: None)
    cuda = {**settings, "bgremove_device": "cuda"}
    report = bi.doctor(cuda)
    assert not report["ok"] and report["action"] is None
    lines: list[str] = []
    bi.repair(cuda, log=lines.append)
    assert any("--device auto" in line for line in lines)


def test_doctor_finishes_interrupted_download(settings: dict[str, Any], small_registry: list[str]) -> None:
    f = _model_file(settings, "bgremove-birefnet-lite")
    f.parent.mkdir(parents=True)
    f.with_suffix(".download").write_bytes(b"partial")
    report = bi.doctor(settings)
    assert report["redownload"] == ["bgremove-birefnet-lite"]


def test_uninstall_only_touches_bgremove_models(settings: dict[str, Any], small_registry: list[str]) -> None:
    bi.install(["birefnet-general", "birefnet-lite"], settings, lambda _: None)
    nudenet = Path(settings["onnx_models_dir"]) / "320n.onnx"
    nudenet.write_bytes(b"n")
    assert bi.uninstall(["birefnet-lite"], settings, lambda _: None) == ["bgremove-birefnet-lite"]
    assert bi.uninstall(None, settings, lambda _: None) == [rt.DEFAULT_MODEL]
    assert nudenet.exists()


# --------------------------------------------------------------------------- capability + executor config


def test_check_onnx_hides_bgremove_when_device_unavailable(monkeypatch: pytest.MonkeyPatch,
                                                           settings: dict[str, Any],
                                                           small_registry: list[str]) -> None:
    from offloadmq_agent import capabilities_sync

    bi.install(None, settings, lambda _: None)
    current = dict(settings)
    monkeypatch.setattr(onnx_models, "load_config", lambda: current)
    monkeypatch.setattr(rt, "load_agent_settings", lambda: current)
    assert "onnx.bgremove.birefnet-general" in capabilities_sync.check_onnx().caps

    current["bgremove_device"] = "cuda"
    r = capabilities_sync.check_onnx()
    assert r.caps == [] and "hidden" in r.reason


def test_session_cache_follows_settings(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import onnxruntime as ort

    created: list[tuple[list[str], int]] = []

    class FakeSession:
        def __init__(self, path: str, opts: Any, providers: list[str]) -> None:
            created.append((providers, opts.intra_op_num_threads))

        def get_providers(self) -> list[str]:
            return ["CPUExecutionProvider"]

    monkeypatch.setattr(ort, "InferenceSession", FakeSession)
    bgremove.release_sessions()
    model = tmp_path / "m.onnx"
    keep = rt.BgRemoveConfig("cpu", 0, True)
    a = bgremove._session(model, keep)
    assert bgremove._session(model, keep) is a and len(created) == 1
    b = bgremove._session(model, rt.BgRemoveConfig("cpu", 2, True))  # threads changed → reload
    assert b is not a and created[-1][1] == 2
    once = rt.BgRemoveConfig("cpu", 2, False)
    bgremove.release_sessions()
    bgremove._session(model, once)
    bgremove._session(model, once)
    assert len(created) == 4  # not cached
    with pytest.raises(rt.BgRemoveConfigError):
        bgremove._session(model, rt.BgRemoveConfig("cuda", 0, True))
    bgremove.release_sessions()


# --------------------------------------------------------------------------- orchestrator + CLI


@pytest.fixture()
def orch(tmp_path: Path) -> Any:
    from offloadmq_core.orchestrator import Orchestrator

    o = Orchestrator(settings_path=tmp_path / "agent.json")
    o.update_settings(onnx_models_dir=str(tmp_path / "models"))
    o.start_background_scan = lambda: None  # type: ignore[method-assign]
    return o


def _wait_job(o: Any) -> dict[str, Any]:
    done = threading.Event()
    for _ in range(200):
        snap: dict[str, Any] = o.get_bgremove_status()["job"]
        if snap["state"] != "running":
            return snap
        done.wait(0.05)
    raise AssertionError("job did not finish")


def test_orchestrator_settings_install_doctor_uninstall(orch: Any, small_registry: list[str]) -> None:
    st = orch.update_bgremove_settings(device="CPU", threads=3, keep_loaded=False)
    assert st["settings"] == {
        "onnx_models_dir": orch.get_settings().onnx_models_dir,
        "bgremove_device": "cpu", "bgremove_threads": 3, "bgremove_keep_loaded": False,
    }
    with pytest.raises(rt.BgRemoveConfigError):
        orch.update_bgremove_settings(device="tpu")
    with pytest.raises(ValueError):
        orch.update_bgremove_settings(threads=-1)

    orch.start_bgremove_install(["birefnet-lite"])
    assert _wait_job(orch)["state"] == "succeeded"
    st = orch.get_bgremove_status()
    assert [m["short"] for m in st["models"] if m["installed"]] == ["birefnet-lite"] and st["ready"]
    assert orch.run_bgremove_doctor()["ok"]

    orch.start_bgremove_uninstall(None)
    assert _wait_job(orch)["state"] == "succeeded"
    assert not orch.get_bgremove_status()["ready"]


def test_settings_survive_save(tmp_path: Path) -> None:
    """onnx_models_dir used to be read but was not a Settings field, so saves dropped it."""
    from offloadmq_core.settings import Settings, load_settings, save_settings

    path = tmp_path / "s.json"
    save_settings(Settings(onnx_models_dir=" E:/models ", bgremove_device="cuda", bgremove_threads=2), path)
    s = load_settings(path)
    assert (s.onnx_models_dir, s.bgremove_device, s.bgremove_threads, s.bgremove_keep_loaded) == ("E:/models", "cuda", 2, True)


def test_ui_routes(orch: Any, small_registry: list[str]) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from ui_server.api import create_router

    app = FastAPI()
    app.include_router(create_router(orch))
    client = TestClient(app)
    assert client.get("/api/bgremove/status").json()["device"] == "auto"
    assert client.post("/api/bgremove/settings", json={"bgremove_device": "tpu"}).status_code == 409
    r = client.post("/api/bgremove/settings", json={"bgremove_device": "cpu", "bgremove_threads": 1})
    assert r.status_code == 200 and r.json()["threads"] == 1
    assert client.post("/api/bgremove/install", json={"models": ["nope"]}).status_code == 409
    assert client.post("/api/bgremove/install", json={"models": ["birefnet-lite"]}).status_code == 200
    assert _wait_job(orch)["state"] == "succeeded"
    assert client.post("/api/bgremove/doctor").json()["ok"]


def test_cli_config_and_status(orch: Any, monkeypatch: pytest.MonkeyPatch, small_registry: list[str]) -> None:
    from typer.testing import CliRunner

    from cli_manager import main as cli

    monkeypatch.setattr(cli, "_orch", lambda: orch)
    runner = CliRunner()
    r = runner.invoke(cli.app, ["bgremove", "config", "--device", "cpu", "--threads", "2", "--no-keep-loaded"])
    assert r.exit_code == 1  # status exits 1 while nothing is installed
    assert orch.get_settings().bgremove_threads == 2 and not orch.get_settings().bgremove_keep_loaded
    assert runner.invoke(cli.app, ["bgremove", "config", "--device", "tpu"]).exit_code == 1

    r = runner.invoke(cli.app, ["bgremove", "install", "birefnet-lite"])
    assert r.exit_code == 0, r.output
    r = runner.invoke(cli.app, ["bgremove", "status"])
    assert r.exit_code == 0 and "birefnet-lite" in r.output
    assert runner.invoke(cli.app, ["bgremove", "doctor"]).exit_code == 0
    assert runner.invoke(cli.app, ["bgremove", "uninstall", "--yes"]).exit_code == 0
    assert runner.invoke(cli.app, ["bgremove", "doctor"]).exit_code == 1
