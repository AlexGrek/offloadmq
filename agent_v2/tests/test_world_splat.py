"""Unit tests for the world.splat capability (image → Gaussian-splat PLY)."""
from __future__ import annotations

import io
import json
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from offloadmq_agent.cap_policy import classify_capabilities, compute_registration_caps
from offloadmq_agent.capabilities_sync import WORLD_SPLAT_CAP
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.exec.world import executor as world_exec
from offloadmq_agent.exec.world import splat
from offloadmq_agent.pipeline import _takes_output_bucket
from offloadmq_agent.wire import TaskId, TaskResultReport

FIXTURES = Path(__file__).parent / "fixtures" / "comfy"
REPO_DEPTH = Path(__file__).parents[1] / "workflows" / "img-utils" / "depth"


def _parse_ply(data: bytes) -> tuple[list[str], np.ndarray]:
    head, _, body = data.partition(b"end_header\n")
    lines = head.decode("ascii").splitlines()
    assert lines[0] == "ply" and lines[1] == "format binary_little_endian 1.0"
    count = int(lines[2].split()[-1])
    fields = [ln.split()[-1] for ln in lines if ln.startswith("property float")]
    arr = np.frombuffer(body, dtype=np.float32).reshape(count, len(fields))
    return fields, arr


def _step_scene(w: int = 64, h: int = 32) -> tuple[Image.Image, Image.Image]:
    """Left half near (white), right half far (black): one sharp depth edge."""
    rgb = np.zeros((h, w, 3), np.uint8)
    rgb[:, : w // 2] = (200, 50, 50)
    rgb[:, w // 2 :] = (50, 50, 200)
    depth = np.zeros((h, w), np.uint8)
    depth[:, : w // 2] = 255
    return Image.fromarray(rgb), Image.fromarray(depth)


# --------------------------------------------------------------------------- math


@pytest.mark.parametrize(
    ("size", "requested", "expected"),
    [((2048, 1024), None, "pano"), ((2048, 1024), "auto", "pano"), ((1344, 768), None, "perspective"),
     ((2048, 1024), "perspective", "perspective"), ((800, 800), "pano", "pano")],
)
def test_resolve_mode(size: tuple[int, int], requested: str | None, expected: str) -> None:
    assert splat.resolve_mode(*size, requested) == expected


def test_resolve_mode_rejects_unknown() -> None:
    with pytest.raises(ValueError):
        splat.resolve_mode(100, 100, "cubemap")


def test_quaternions_are_unit_and_face_the_ray() -> None:
    dirs = np.array([[0, 0, 1], [1, 0, 1], [0, -1, 0.2], [0, 0, -1]], dtype=np.float64)
    q = splat.quat_look(dirs)
    assert np.allclose(np.linalg.norm(q, axis=1), 1.0)
    assert np.allclose(q[0], [1, 0, 0, 0])  # +Z already faces +Z


def test_perspective_backprojection_puts_centre_on_axis() -> None:
    z = np.full((10, 20), 5.0, dtype=np.float32)
    xyz, foot, _ = splat.backproject(z, "perspective", 90.0)
    centre = xyz[4:6, 9:11].reshape(-1, 3).mean(0)
    assert abs(centre[0]) < 1e-6 and abs(centre[1]) < 1e-6 and centre[2] == pytest.approx(5.0)
    assert (foot > 0).all()


def test_pano_backprojection_wraps_the_sphere() -> None:
    z = np.full((8, 16), 3.0, dtype=np.float32)
    xyz, _, _ = splat.backproject(z, "pano", 70.0)
    radii = np.linalg.norm(xyz.reshape(-1, 3), axis=1)
    assert np.allclose(radii, 3.0, atol=1e-5)
    # Horizon row covers directions in front (+z) and behind (-z) the viewer.
    horizon = xyz[4]
    assert horizon[:, 2].max() > 2.5 and horizon[:, 2].min() < -2.5


def test_background_layer_fills_behind_the_near_side_only() -> None:
    z = np.ones((4, 10), np.float32)
    z[:, 5:] = 10.0
    rgb = np.zeros((4, 10, 3), np.float32)
    rgb[:, 5:] = (0, 0, 1)
    mask, colour, depth = splat.background_layer(rgb, z, iters=3, jump=1.5)
    assert mask[:, 2:5].all() and not mask[:, :2].any() and not mask[:, 5:].any()
    assert np.allclose(depth[mask], 10.0)
    assert np.allclose(colour[mask], (0, 0, 1))


def test_build_world_writes_a_valid_3dgs_ply() -> None:
    rgb, depth = _step_scene()
    world = splat.build_world(rgb, depth, splat.SplatSettings(mode="perspective", max_width=64))
    fields, data = _parse_ply(world.ply)
    assert fields == list(splat.PLY_FIELDS)
    assert len(data) == world.splat_count == world.splats_fg + world.splats_bg
    assert world.splats_fg == 64 * 32 and world.splats_bg > 0
    assert np.isfinite(data).all()
    assert world.depth_min == pytest.approx(1.2) and world.depth_max == pytest.approx(50.0, rel=0.05)
    assert Image.open(io.BytesIO(world.preview_png)).size == (1024, 616)


def test_build_world_respects_the_splat_budget() -> None:
    rgb, depth = _step_scene(200, 100)
    world = splat.build_world(rgb, depth, splat.SplatSettings(max_width=100, fill_lean=0))
    assert (world.grid_width, world.grid_height) == (100, 50)
    assert world.splat_count == 100 * 50


def test_parse_settings_clamps() -> None:
    s = world_exec.parse_settings({"max_width": 99999, "near": 5, "far": 1, "hfov": "300"}, 2000, 1000)
    assert s.mode == "pano" and s.max_width == world_exec.MAX_WIDTH_LIMIT
    assert s.far >= s.near + 0.5 and s.hfov == 150.0
    with pytest.raises(ValueError):
        world_exec.parse_settings({"near": "close"}, 10, 10)


# --------------------------------------------------------------------------- registration


def test_registered_as_regular_capability() -> None:
    assert classify_capabilities([WORLD_SPLAT_CAP])["regular"] == [WORLD_SPLAT_CAP]
    assert WORLD_SPLAT_CAP in compute_registration_caps({}, [WORLD_SPLAT_CAP])
    assert WORLD_SPLAT_CAP not in compute_registration_caps(
        {"regular_disabled_caps": [WORLD_SPLAT_CAP]}, [WORLD_SPLAT_CAP])


def test_routed_with_output_bucket() -> None:
    assert route_executor("world.splat") is world_exec.execute_world_splat
    assert _takes_output_bucket("world.splat")


def test_find_depth_pack_prefers_depth_then_any(tmp_path: Path) -> None:
    assert world_exec.find_depth_pack(tmp_path) is None
    lotus = tmp_path / "img-utils" / "image_lotus_depth_v1_1"
    shutil.copytree(REPO_DEPTH, lotus)
    assert world_exec.find_depth_pack(tmp_path) == "image_lotus_depth_v1_1"
    shutil.copytree(REPO_DEPTH, tmp_path / "img-utils" / "depth")
    assert world_exec.find_depth_pack(tmp_path) == "depth"


# --------------------------------------------------------------------------- executor


class _Response:
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

    def post_task_progress(self, task_id, report, timeout: int = 10) -> _Response:  # type: ignore[no-untyped-def]
        return _Response()

    def post_task_result(self, report, timeout: int = 60) -> _Response:  # type: ignore[no-untyped-def]
        self.result = report
        return _Response()


@pytest.fixture()
def fake_comfy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    workflows = tmp_path / "workflows"
    shutil.copytree(REPO_DEPTH, workflows / "img-utils" / "depth")
    monkeypatch.setattr(world_exec.wf, "WORKFLOWS_DIR", workflows)
    calls: dict[str, Any] = {}

    def upload_image(path: Path) -> str:
        calls["uploaded_size"] = Image.open(path).size
        return "comfy_in.png"

    def queue_prompt(graph: dict[str, Any], transport: Any = None, task_id: Any = None) -> str:
        calls["graph"] = graph
        return "prompt-1"

    def wait_for_completion(prompt_id: str, *a: Any, **k: Any) -> dict[str, Any]:
        return {"outputs": {"9": {"images": [{"filename": "d.png", "subfolder": "", "type": "output"}]}}}

    def download_file(filename: str, subfolder: str, file_type: str) -> tuple[bytes, str]:
        w, h = calls["uploaded_size"]
        _, depth = _step_scene(w, h)
        buf = io.BytesIO()
        depth.save(buf, format="PNG")
        return buf.getvalue(), "image/png"

    monkeypatch.setattr(world_exec.wf, "upload_image", upload_image)
    monkeypatch.setattr(world_exec, "queue_prompt", queue_prompt)
    monkeypatch.setattr(world_exec, "wait_for_completion", wait_for_completion)
    monkeypatch.setattr(world_exec, "download_file", download_file)
    return calls


def _run(tmp_path: Path, payload: dict[str, Any], bucket: str | None = "out") -> _FakeTransport:
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    t = _FakeTransport()
    world_exec.execute_world_splat(
        t,  # type: ignore[arg-type]
        TaskId(id="task-1", cap="world.splat"), "world.splat", payload, data, output_bucket=bucket,
    )
    return t


def test_executor_end_to_end(tmp_path: Path, fake_comfy: dict[str, Any]) -> None:
    (tmp_path / "data").mkdir()
    Image.new("RGB", (400, 200), (90, 120, 60)).save(tmp_path / "data" / "in_1.jpg")

    t = _run(tmp_path, {"input_image": "in_1.jpg", "max_width": 256})

    assert t.result is not None and t.result.status.status == "success", t.result
    out = t.result.output
    assert out["mode"] == "pano"  # 2:1 → auto pano
    assert out["grid"] == {"width": 256, "height": 128}
    assert fake_comfy["uploaded_size"] == (256, 128)
    assert fake_comfy["graph"]["12"]["inputs"]["image"] == "comfy_in.png"
    assert set(t.uploads) == {"scene.ply", "preview.png", "depth.png"}
    assert out["ply"]["file_uid"] == "uid-scene.ply" and out["ply"]["bucket_uid"] == "out"
    assert out["ply"]["bytes"] == len(t.uploads["scene.ply"])
    fields, data = _parse_ply(t.uploads["scene.ply"])
    assert len(data) == out["splat_count"]
    json.dumps(out)  # result must be JSON-serialisable


def test_executor_fails_cleanly(tmp_path: Path, fake_comfy: dict[str, Any]) -> None:
    t = _run(tmp_path, {"input_image": "missing.png"})
    assert t.result is not None and t.result.status.status != "success"
    t = _run(tmp_path, {"input_image": "../escape.png"})
    assert t.result is not None and "escapes" in json.dumps(t.result.output)
    t = _run(tmp_path, {"input_image": "x.png"}, bucket=None)
    assert t.result is not None and "output_bucket" in json.dumps(t.result.output)
