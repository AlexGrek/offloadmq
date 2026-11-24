"""Unit tests for world.pano360: geometry, model resolution, installer/doctor, executor, surfaces.

ComfyUI is faked at the ``requests.get`` level; its LoRA list follows the files in a
temp ``loras`` folder, so installing/uninstalling changes what the fake reports.
"""
from __future__ import annotations

import hashlib
import io
import json
import shutil
import threading
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import requests
from PIL import Image

from offloadmq_agent import capabilities_sync as caps
from offloadmq_agent.exec.imggen import workflow as wf
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.exec.world import pano360
from offloadmq_agent.exec.world import pano360_runtime as rt
from offloadmq_agent.pipeline import _takes_output_bucket
from offloadmq_agent.wire import TaskId, TaskResultReport
from offloadmq_core import pano360_install as pi

REPO_DEPTH = Path(__file__).parents[1] / "workflows" / "img-utils" / "depth"
URL = "http://comfy.test"
LORA_BYTES = b"fake-lora-weights" * 64
UNETS = ["flux1-dev-kontext_fp8_scaled.safetensors", "flux1-krea-dev_fp8_scaled.safetensors",
         "z_image_turbo_bf16.safetensors"]
CLIPS = ["clip_l.safetensors", "clip_l_hidream.safetensors", "t5xxl_fp16.safetensors",
         "t5xxl_fp8_e4m3fn_scaled.safetensors"]
VAES = ["ae.safetensors", "wan_2.1_vae.safetensors"]


# --------------------------------------------------------------------------- fake ComfyUI


class _Resp:
    def __init__(self, payload: Any = None, content: bytes = b"", status: int = 200) -> None:
        self._payload, self.content, self.status_code = payload, content, status

    def json(self) -> Any:
        return self._payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")

    def iter_content(self, chunk_size: int = 1) -> Any:
        for i in range(0, len(self.content), 100):
            yield self.content[i:i + 100]

    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *a: Any) -> None:
        pass


@pytest.fixture()
def comfy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    loras = tmp_path / "comfy-loras"
    loras.mkdir()
    workflows = tmp_path / "workflows"
    shutil.copytree(REPO_DEPTH, workflows / "img-utils" / "depth")
    other = tmp_path / "other-loras"
    other.mkdir()
    state: dict[str, Any] = {"up": True, "loras": loras, "other": other, "nodes": set(rt.REQUIRED_NODES)}

    def node_info(node: str) -> dict[str, Any]:
        lists = {"UNETLoader": ("unet_name", UNETS), "DualCLIPLoader": ("clip_name1", CLIPS),
                 "VAELoader": ("vae_name", VAES),
                 "LoraLoaderModelOnly": ("lora_name", sorted(p.name for d in (loras, other) for p in d.iterdir()
                                                            if p.suffix == ".safetensors"))}
        if node in lists:
            key, names = lists[node]
            # Newer ComfyUI combo format for one loader, legacy for the rest.
            spec: Any = ["COMBO", {"options": names}] if node == "VAELoader" else [names]
            return {"input": {"required": {key: spec}}}
        return {"input": {"required": {}}}

    def fake_get(url: str, *a: Any, **k: Any) -> _Resp:
        if url == rt.LORA_URL:
            return _Resp(content=LORA_BYTES)
        if not state["up"]:
            raise requests.ConnectionError("down")
        path = url.removeprefix(URL)
        if path == "/internal/folder_paths":
            return _Resp({"loras": [str(loras), str(other)]})
        if path == "/object_info":
            return _Resp({n: node_info(n) for n in state["nodes"]})
        if path.startswith("/object_info/"):
            node = path.rsplit("/", 1)[1]
            return _Resp({node: node_info(node)} if node in state["nodes"] else {})
        return _Resp(status=404)

    monkeypatch.setattr(requests, "get", fake_get)
    monkeypatch.setattr(rt, "LORA_SHA256", hashlib.sha256(LORA_BYTES).hexdigest())
    monkeypatch.setattr(rt, "LORA_BYTES", len(LORA_BYTES))
    monkeypatch.setattr(wf, "_find_workflows_dir", lambda: workflows)
    monkeypatch.setattr(wf, "WORKFLOWS_DIR", workflows)
    monkeypatch.setattr(rt, "load_agent_settings", lambda: {"comfyui_url": URL})
    return state


SETTINGS: dict[str, Any] = {"comfyui_url": URL}


# --------------------------------------------------------------------------- geometry


def test_projection_covers_expected_fraction_and_pitch_moves_it_down() -> None:
    src = Image.new("RGB", (400, 300), (200, 50, 50))
    rgb, covered = pano360.project_to_pano(src, 90.0, 0.0, 512, 256)
    assert covered[128, 256] and not covered[128, 0] and not covered[5, 256]
    # 90 deg x ~74 deg of a 360 x 180 sphere is roughly 8-10 %
    assert 0.07 < covered.mean() < 0.11
    assert np.allclose(rgb[covered].mean(0), [200 / 255, 50 / 255, 50 / 255], atol=0.01)
    _, down = pano360.project_to_pano(src, 90.0, -30.0, 512, 256)
    rows = np.nonzero(covered.any(1))[0]
    rows_down = np.nonzero(down.any(1))[0]
    assert rows_down.mean() > rows.mean() + 20  # below the horizon now


def test_pull_push_seed_carries_picture_colour_everywhere() -> None:
    src = Image.new("RGB", (200, 150), (40, 160, 90))
    rgb, covered = pano360.project_to_pano(src, 70.0, 0.0, 256, 128)
    seeded = pano360.pull_push_fill(rgb, covered)
    # Regression: an all-black seed made FLUX paint a dark room around the picture.
    assert np.allclose(seeded[~covered].mean(0), [40 / 255, 160 / 255, 90 / 255], atol=0.02)


def test_masks_paste_alpha_and_seam_band() -> None:
    covered = np.zeros((64, 128), bool)
    covered[16:48, 40:88] = True
    regen = pano360.feather(~covered, 4)
    assert regen[0, 0] == 1.0 and regen[32, 64] == 0.0 and 0 < regen[32, 41] < 1
    alpha = pano360.paste_alpha(covered, 2)
    assert alpha[0, 0] == 0 and alpha[32, 64] == 1 and alpha[32, 40] < 0.5
    rgba = pano360.to_rgba(np.zeros((64, 128, 3), np.float32), regen)
    a = np.asarray(rgba)[..., 3]
    assert a[0, 0] == 0 and a[32, 64] == 255  # LoadImage MASK = 1 - alpha
    band = pano360.seam_band(128, 64, 0.25)
    assert band[:, 64].all() and not band[:, 0].any() and band.sum() == 64 * 32


def test_parse_options_defaults_clamps_and_rejects_pano() -> None:
    o = pano360.parse_options({"input_image": "x.png", "hfov": 500, "pitch": -90, "seed": "12", "prompt": "  a\nb  "})
    assert (o["hfov"], o["pitch"], o["seed"], o["prompt"]) == (120.0, -60.0, 12, "a b")
    assert o["denoise"] == 1.0 and o["steps"] == 28 and o["max_width"] == 1536
    assert pano360.parse_options({})["prompt"] == "a scene"
    with pytest.raises(ValueError, match="world.splat"):
        pano360.parse_options({"mode": "pano"})
    with pytest.raises(ValueError, match="seed"):
        pano360.parse_options({"seed": "abc"})


def test_outpaint_graph_wires_models_and_mask() -> None:
    models = rt.Pano360Models("u.safetensors", "c.safetensors", "t.safetensors", "v.safetensors", rt.LORA_NAME)
    g = pano360.outpaint_graph("in.png", "p", models, 1600, 800, seed=3, steps=20, guidance=4.0, denoise=1.0)
    assert g["unet"]["inputs"]["unet_name"] == "u.safetensors"
    assert g["lora"]["inputs"]["lora_name"] == rt.LORA_NAME
    assert g["nm"]["inputs"]["mask"] == ["load", 1]  # the alpha channel
    assert g["ks"]["inputs"]["model"] == ["dd", 0] and g["ks"]["inputs"]["seed"] == 3
    assert {n["class_type"] for n in g.values()} <= set(rt.REQUIRED_NODES)


# --------------------------------------------------------------------------- runtime


def test_auto_pickers() -> None:
    assert rt.auto_unet(UNETS) == "flux1-krea-dev_fp8_scaled.safetensors"  # kontext excluded
    assert rt.auto_unet(["flux1-fill-dev.safetensors", "flux1-schnell.safetensors"]) is None
    assert rt.auto_clip_l(CLIPS) == "clip_l.safetensors"
    assert rt.auto_t5(CLIPS) == "t5xxl_fp8_e4m3fn_scaled.safetensors"
    assert rt.auto_vae(VAES) == "ae.safetensors"
    assert rt.find_lora(["sub\\worldgen_text2scene.safetensors"]) == "sub\\worldgen_text2scene.safetensors"
    assert rt.combo_options(["COMBO", {"options": ["a"]}]) == ["a"] and rt.combo_options([["b"]]) == ["b"]


def test_status_needs_lora_and_honours_explicit_models(comfy: dict[str, Any]) -> None:
    st = rt.status(SETTINGS)
    assert st.reachable and not st.ready and "omq pano360 install" in st.describe()
    assert st.models.unet == "flux1-krea-dev_fp8_scaled.safetensors"
    (comfy["loras"] / rt.LORA_NAME).write_bytes(LORA_BYTES)
    assert rt.status(SETTINGS).ready
    st = rt.status({**SETTINGS, "pano360_unet": "missing.safetensors"})
    assert not st.ready and "pano360_unet" in st.describe()
    st = rt.status({**SETTINGS, "pano360_unet": "flux1-dev-kontext_fp8_scaled.safetensors"})
    assert st.ready and st.models.unet.startswith("flux1-dev-kontext")  # explicit wins over the filter
    comfy["up"] = False
    st = rt.status(SETTINGS)
    assert not st.reachable and "not reachable" in st.describe()
    assert st.to_dict()["ready"] is False


def test_lora_target_dir(comfy: dict[str, Any], tmp_path: Path) -> None:
    assert rt.lora_target_dir(SETTINGS) == comfy["loras"]
    assert rt.lora_target_dir({**SETTINGS, "pano360_lora_dir": str(tmp_path / "x")}) == tmp_path / "x"
    comfy["up"] = False
    with pytest.raises(RuntimeError, match="pano360_lora_dir"):
        rt.lora_target_dir(SETTINGS)


def test_capability_probe_route_and_bucket(comfy: dict[str, Any]) -> None:
    r = caps.check_world_pano360()
    assert not r.ok and not r.caps and "omq pano360 install" in r.reason
    (comfy["loras"] / rt.LORA_NAME).write_bytes(LORA_BYTES)
    r = caps.check_world_pano360()
    assert r.ok and r.caps == [caps.WORLD_PANO360_CAP]
    assert route_executor("world.pano360") is pano360.execute_world_pano360
    assert route_executor("world.splat") is not pano360.execute_world_pano360
    assert _takes_output_bucket("world.pano360")


# --------------------------------------------------------------------------- installer


def test_install_verify_skip_force_uninstall(comfy: dict[str, Any]) -> None:
    log: list[str] = []
    path = Path(pi.install(SETTINGS, log.append))
    assert path == comfy["loras"] / rt.LORA_NAME and path.read_bytes() == LORA_BYTES
    assert pi.verify_lora(path)[0]
    pi.install(SETTINGS, log.append)
    assert any("Already installed" in line for line in log)
    path.write_bytes(b"corrupt")
    assert not pi.verify_lora(path)[0]
    pi.install(SETTINGS, log.append, force=True)
    assert pi.verify_lora(path)[0] and not list(comfy["loras"].glob("*.part"))
    assert pi.uninstall(SETTINGS, log.append) and not path.exists()
    assert not pi.uninstall(SETTINGS, log.append)


def test_install_rejects_bad_checksum_and_cancel(comfy: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rt, "LORA_SHA256", "0" * 64)
    with pytest.raises(pi.Pano360InstallError, match="checksum"):
        pi.install(SETTINGS, lambda _l: None)
    assert not any(comfy["loras"].iterdir())  # no partial file left behind
    with pytest.raises(pi.Pano360InstallError, match="cancelled"):
        pi.install(SETTINGS, lambda _l: None, cancelled=lambda: True)


def test_lora_found_in_another_comfy_folder(comfy: dict[str, Any]) -> None:
    copy = comfy["other"] / rt.LORA_NAME
    copy.write_bytes(LORA_BYTES)
    assert pi.installed_lora(SETTINGS) == copy and pi.doctor(SETTINGS)["ok"]
    copy.write_bytes(b"corrupt")
    report = pi.doctor(SETTINGS)
    assert report["action"] == "install" and str(copy) in next(
        c["detail"] for c in report["checks"] if c["name"] == "LoRA file")
    assert pi.install(SETTINGS, lambda _l: None, force=True) == str(copy)  # replaced in place
    assert copy.read_bytes() == LORA_BYTES and not (comfy["loras"] / rt.LORA_NAME).exists()
    assert pi.uninstall(SETTINGS, lambda _l: None) and not copy.exists()


def test_doctor_and_repair(comfy: dict[str, Any]) -> None:
    report = pi.doctor(SETTINGS)
    assert not report["ok"] and report["action"] == "install"
    names = {c["name"]: c["ok"] for c in report["checks"]}
    assert names["nodes"] and names["FLUX UNET"] and not names["LoRA in ComfyUI"] and names["depth workflow"]
    report = pi.repair(SETTINGS, lambda _l: None)
    assert report["ok"] and report["action"] is None
    comfy["nodes"].discard("DifferentialDiffusion")
    report = pi.doctor(SETTINGS)
    assert not report["ok"] and report["action"] is None
    assert "DifferentialDiffusion" in next(c["detail"] for c in report["checks"] if c["name"] == "nodes")
    comfy["up"] = False
    assert not pi.doctor(SETTINGS)["checks"][0]["ok"]


# --------------------------------------------------------------------------- executor


class _ProgressResp:
    status_code = 200
    content = b""

    def raise_for_status(self) -> None:
        pass


class _FakeTransport:
    def __init__(self) -> None:
        self.uploads: dict[str, bytes] = {}
        self.result: TaskResultReport | None = None

    def upload_file(self, bucket_uid: str, filename: str, content: bytes, content_type: str,
                    timeout: int = 300) -> str:
        self.uploads[filename] = content
        return f"uid-{filename}"

    def post_task_progress(self, task_id, report, timeout: int = 10) -> _ProgressResp:  # type: ignore[no-untyped-def]
        return _ProgressResp()

    def post_task_result(self, report, timeout: int = 60) -> _ProgressResp:  # type: ignore[no-untyped-def]
        self.result = report
        return _ProgressResp()


def _run(tmp_path: Path, payload: dict[str, Any], bucket: str | None = "out") -> _FakeTransport:
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    t = _FakeTransport()
    pano360.execute_world_pano360(
        t,  # type: ignore[arg-type]
        TaskId(id="task-1", cap="world.pano360"), "world.pano360", payload, data, output_bucket=bucket,
    )
    return t


def test_executor_end_to_end(tmp_path: Path, comfy: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    (comfy["loras"] / rt.LORA_NAME).write_bytes(LORA_BYTES)
    monkeypatch.setattr(pano360, "CANVAS_WIDTH", 256)
    monkeypatch.setattr(pano360, "GEN_WIDTH", 128)
    calls: list[dict[str, Any]] = []

    def fake_inpaint(transport: Any, task_id: Any, rgba: Image.Image, path: Path, graph_args: dict[str, Any],
                     stage: str, job_timeout: int) -> tuple[Any, str]:
        assert rgba.mode == "RGBA" and rgba.size == (128, 64)
        calls.append({"stage": stage, **{k: graph_args[k] for k in ("seed", "denoise", "prompt")}})
        return np.full((64, 128, 3), 0.3, np.float32), f"pid-{stage}"

    def fake_depth(transport: Any, task_id: Any, name: str, data: Path, timeout: int) -> tuple[Image.Image, str]:
        assert Image.open(data / name).size == (256, 128)
        return Image.new("L", (256, 128), 128), "pid-depth"

    monkeypatch.setattr(pano360, "_inpaint", fake_inpaint)
    monkeypatch.setattr(pano360, "_run_depth", fake_depth)
    (tmp_path / "data").mkdir()
    Image.new("RGB", (120, 90), (220, 30, 30)).save(tmp_path / "data" / "in.png")

    t = _run(tmp_path, {"input_image": "in.png", "seed": 5, "prompt": "a red room", "max_width": 256})

    assert t.result is not None and t.result.status.status == "success", t.result
    out = t.result.output
    assert [c["stage"] for c in calls] == ["outpaint", "seam"]
    assert calls[0]["seed"] == 5 and calls[1]["seed"] == 6 and calls[0]["denoise"] == 1.0
    assert calls[1]["denoise"] == pano360.SEAM_DENOISE and "a red room" in calls[0]["prompt"]
    assert calls[0]["prompt"].startswith(pano360.PROMPT_PREFIX)
    assert set(t.uploads) == {"scene.ply", "preview.png", "depth.png", "panorama.jpg"}
    assert out["mode"] == "pano" and out["generator"] == pano360.GENERATOR
    assert out["grid"] == {"width": 256, "height": 128} and 0 < out["coverage"] < 0.2
    assert out["models"]["lora"] == rt.LORA_NAME and out["prompt_ids"]["depth"] == "pid-depth"
    assert out["panorama"]["file_uid"] == "uid-panorama.jpg"
    pano = np.asarray(Image.open(io.BytesIO(t.uploads["panorama.jpg"])), np.float32)
    assert pano[64, 128, 0] > 180 and pano[64, 5, 0] < 120  # original pasted back, generated elsewhere
    json.dumps(out)


def test_executor_fails_cleanly(tmp_path: Path, comfy: dict[str, Any]) -> None:
    t = _run(tmp_path, {"input_image": "x.png"})  # LoRA missing → not ready
    assert t.result is not None and "not ready" in json.dumps(t.result.output)
    (comfy["loras"] / rt.LORA_NAME).write_bytes(LORA_BYTES)
    t = _run(tmp_path, {"input_image": "missing.png"})
    assert t.result is not None and t.result.status.status != "success"
    t = _run(tmp_path, {"input_image": "x.png", "mode": "pano"})
    assert t.result is not None and "world.splat" in json.dumps(t.result.output)
    t = _run(tmp_path, {"input_image": "x.png"}, bucket=None)
    assert t.result is not None and "output_bucket" in json.dumps(t.result.output)


# --------------------------------------------------------------------------- orchestrator / REST / CLI


@pytest.fixture()
def orch(tmp_path: Path, comfy: dict[str, Any]) -> Any:
    from offloadmq_core.orchestrator import Orchestrator

    o = Orchestrator(settings_path=tmp_path / "agent.json")
    o.update_settings(comfyui_url=URL)
    o.start_background_scan = lambda: None  # type: ignore[method-assign]
    return o


def _wait_job(o: Any) -> dict[str, Any]:
    done = threading.Event()
    for _ in range(200):
        snap: dict[str, Any] = o.get_pano360_status()["job"]
        if snap["state"] != "running":
            return snap
        done.wait(0.05)
    raise AssertionError("job did not finish")


def test_orchestrator_settings_install_doctor_uninstall(orch: Any, comfy: dict[str, Any]) -> None:
    st = orch.get_pano360_status()
    assert not st["ready"] and st["lora"]["target_dir"] == str(comfy["loras"])
    assert "flux1-krea-dev_fp8_scaled.safetensors" in st["choices"]["unet"]
    st = orch.update_pano360_settings(unet=" missing.safetensors ")
    assert st["settings"]["pano360_unet"] == "missing.safetensors" and not st["ready"]
    orch.update_pano360_settings(unet="")
    orch.start_pano360_install()
    assert _wait_job(orch)["state"] == "succeeded"
    assert orch.get_pano360_status()["ready"] and orch.run_pano360_doctor()["ok"]
    orch.start_pano360_uninstall()
    assert _wait_job(orch)["state"] == "succeeded"
    assert not orch.get_pano360_status()["ready"]
    orch.start_pano360_repair()
    assert _wait_job(orch)["state"] == "succeeded" and orch.get_pano360_status()["ready"]


def test_settings_survive_save(tmp_path: Path) -> None:
    from offloadmq_core.settings import Settings, load_settings, save_settings

    path = tmp_path / "s.json"
    save_settings(Settings(pano360_unet=" a.safetensors ", pano360_lora_dir=" E:/loras "), path)
    s = load_settings(path)
    assert (s.pano360_unet, s.pano360_lora_dir, s.pano360_t5) == ("a.safetensors", "E:/loras", "")


def test_ui_routes(orch: Any) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from ui_server.api import create_router

    app = FastAPI()
    app.include_router(create_router(orch))
    client = TestClient(app)
    assert client.get("/api/pano360/status").json()["reachable"] is True
    r = client.post("/api/pano360/settings", json={"pano360_t5": "t5xxl_fp16.safetensors"})
    assert r.status_code == 200 and r.json()["models"]["t5"] == "t5xxl_fp16.safetensors"
    assert client.post("/api/pano360/install", json={}).status_code == 200
    assert _wait_job(orch)["state"] == "succeeded"
    assert client.post("/api/pano360/doctor").json()["ok"]
    assert client.post("/api/pano360/cancel").status_code == 200


def test_cli(orch: Any, monkeypatch: pytest.MonkeyPatch, comfy: dict[str, Any]) -> None:
    from typer.testing import CliRunner

    from cli_manager import main as cli

    monkeypatch.setattr(cli, "_orch", lambda: orch)
    runner = CliRunner()
    assert runner.invoke(cli.app, ["pano360", "status"]).exit_code == 1  # LoRA missing
    assert runner.invoke(cli.app, ["pano360", "doctor"]).exit_code == 1
    r = runner.invoke(cli.app, ["pano360", "install"])
    assert r.exit_code == 0, r.output
    r = runner.invoke(cli.app, ["pano360", "status"])
    assert r.exit_code == 0 and "flux1-krea-dev" in r.output
    r = runner.invoke(cli.app, ["pano360", "config", "--vae", "wan_2.1_vae.safetensors"])
    assert r.exit_code == 0 and orch.get_settings().pano360_vae == "wan_2.1_vae.safetensors"
    assert runner.invoke(cli.app, ["pano360", "doctor"]).exit_code == 0
    assert runner.invoke(cli.app, ["pano360", "uninstall", "--yes"]).exit_code == 0
    assert runner.invoke(cli.app, ["pano360", "doctor", "--fix"]).exit_code == 0
