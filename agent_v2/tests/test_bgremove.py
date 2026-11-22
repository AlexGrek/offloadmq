"""Unit tests for the onnx.bgremove.* background-removal capability.

The ONNX models themselves are hundreds of MB, so inference is stubbed; everything
around it (payload parsing, compositing, cropping, encoding, executor plumbing) is real.
"""
from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from offloadmq_agent.exec import bgremove
from offloadmq_agent.exec.bgremove import (
    MODEL_SPECS,
    BgRemoveSpec,
    estimate_foreground,
    execute_bgremove,
    parse_color,
    registry_name,
    remove_background,
)
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.onnx_models import ONNX_MODEL_REGISTRY
from offloadmq_agent.pipeline import _takes_output_bucket
from offloadmq_agent.wire import TaskId, TaskResultReport

CAP = "onnx.bgremove.birefnet-general"


# --------------------------------------------------------------------------
# registry / routing
# --------------------------------------------------------------------------

def test_every_spec_has_a_registry_entry_with_matching_capability() -> None:
    for name in MODEL_SPECS:
        meta = ONNX_MODEL_REGISTRY[name]
        assert meta["capability"].startswith("onnx.bgremove.")
        assert registry_name(meta["capability"]) == name
        assert len(meta["md5"]) == 32


def test_registry_name_ignores_extended_attributes() -> None:
    assert registry_name("onnx.bgremove.birefnet-lite[fast]") == "bgremove-birefnet-lite"


def test_routed_ahead_of_the_generic_onnx_executor() -> None:
    from offloadmq_agent.exec.onnx import execute_onnx

    assert route_executor(CAP) is execute_bgremove
    assert route_executor("onnx.nudenet") is execute_onnx


def test_gets_an_output_bucket() -> None:
    assert _takes_output_bucket(CAP)
    assert not _takes_output_bucket("onnx.nudenet")


# --------------------------------------------------------------------------
# payload
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "raw, expected",
    [
        (None, None),
        ("transparent", None),
        ("#00ff00", (0, 255, 0)),
        ("FF8000", (255, 128, 0)),
        ([1, 2, 3], (1, 2, 3)),
    ],
)
def test_parse_color(raw: Any, expected: Any) -> None:
    assert parse_color(raw) == expected


@pytest.mark.parametrize("raw", ["green", "#fff", [1, 2], [0, 0, 300], 5])
def test_parse_color_rejects_garbage(raw: Any) -> None:
    with pytest.raises(ValueError):
        parse_color(raw)


def test_defaults_are_transparent_png() -> None:
    spec = BgRemoveSpec.from_payload({})
    assert (spec.fmt, spec.background, spec.crop, spec.refine_foreground) == ("png", None, False, True)


def test_jpeg_without_background_gets_white() -> None:
    assert BgRemoveSpec.from_payload({"format": "jpg"}).background == (255, 255, 255)
    assert BgRemoveSpec.from_payload({"format": "jpeg", "background": "#000000"}).background == (0, 0, 0)


@pytest.mark.parametrize(
    "payload, message",
    [
        ({"format": "gif"}, "Unsupported format"),
        ({"padding": -1}, "padding"),
        ({"alpha_threshold": 1.0}, "alpha_threshold"),
        ({"quality": 0}, "quality"),
    ],
)
def test_rejects_bad_payloads(payload: dict[str, Any], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        BgRemoveSpec.from_payload(payload)


# --------------------------------------------------------------------------
# compositing
# --------------------------------------------------------------------------

def _subject_image() -> tuple[Image.Image, np.ndarray]:
    """A 100x80 blue-background image with a red 40x20 box at (30, 20); alpha matches."""
    arr = np.zeros((80, 100, 3), np.uint8)
    arr[...] = (0, 0, 255)
    arr[20:40, 30:70] = (255, 0, 0)
    alpha = np.zeros((80, 100), np.float32)
    alpha[20:40, 30:70] = 1.0
    return Image.fromarray(arr, "RGB"), alpha


def test_transparent_png_keeps_alpha() -> None:
    img, alpha = _subject_image()
    content, mask, meta = remove_background(img, alpha, BgRemoveSpec.from_payload({}))

    with Image.open(io.BytesIO(content)) as out:
        assert out.format == "PNG" and out.mode == "RGBA" and out.size == (100, 80)
        assert out.getpixel((50, 30)) == (255, 0, 0, 255)
        assert out.getpixel((5, 5))[3] == 0
    assert meta["transparent"] is True
    assert meta["subject_bbox"] == {"x": 30, "y": 20, "width": 40, "height": 20}
    assert meta["foreground_ratio"] == pytest.approx(0.1)
    with Image.open(io.BytesIO(mask)) as m:
        assert m.mode == "L" and m.getpixel((50, 30)) == 255


def test_solid_background_jpeg() -> None:
    img, alpha = _subject_image()
    spec = BgRemoveSpec.from_payload({"format": "jpeg", "background": "#00ff00"})
    content, _, meta = remove_background(img, alpha, spec)

    with Image.open(io.BytesIO(content)) as out:
        assert out.format == "JPEG" and out.mode == "RGB"
        r, g, b = out.getpixel((5, 5))
        assert g > 240 and r < 15 and b < 15  # JPEG is lossy â€” near-exact green
    assert meta["content_type"] == "image/jpeg" and meta["transparent"] is False


def test_crop_with_padding() -> None:
    img, alpha = _subject_image()
    content, _, meta = remove_background(img, alpha, BgRemoveSpec.from_payload({"crop": True, "padding": 5}))

    with Image.open(io.BytesIO(content)) as out:
        assert out.size == (50, 30)
    assert meta["subject_bbox"] == {"x": 25, "y": 15, "width": 50, "height": 30}


def test_crop_with_padding_clamps_to_the_frame() -> None:
    img, alpha = _subject_image()
    _, _, meta = remove_background(img, alpha, BgRemoveSpec.from_payload({"crop": True, "padding": 500}))
    assert (meta["width"], meta["height"]) == (100, 80)


def test_alpha_threshold_makes_hard_edges() -> None:
    img, _ = _subject_image()
    alpha = np.full((80, 100), 0.4, np.float32)
    content, _, _ = remove_background(img, alpha, BgRemoveSpec.from_payload({"alpha_threshold": 0.5}))
    with Image.open(io.BytesIO(content)) as out:
        assert out.getchannel("A").getextrema() == (0, 0)


def test_foreground_estimation_removes_background_bleed() -> None:
    # Half-transparent edge pixel: 50% red subject over a blue background.
    image = np.zeros((60, 60, 3), np.float32)
    image[...] = (0, 0, 1)
    image[:, :30] = (1, 0, 0)
    alpha = np.zeros((60, 60), np.float32)
    alpha[:, :30] = 1.0
    alpha[:, 30] = 0.5
    image[:, 30] = (0.5, 0, 0.5)

    fg = estimate_foreground(image, alpha)
    # The mixed pixel's estimated foreground is (mostly) red, not purple.
    assert fg[30, 30, 0] > 0.8 and fg[30, 30, 2] < 0.2


# --------------------------------------------------------------------------
# executor end to end (stubbed inference, fake transport)
# --------------------------------------------------------------------------

class _Response:
    status_code = 200
    content = b""

    def raise_for_status(self) -> None:
        pass


class _FakeTransport:
    def __init__(self) -> None:
        self.uploads: list[tuple[str, str, bytes, str]] = []
        self.result: TaskResultReport | None = None

    def upload_file(self, bucket_uid: str, filename: str, content: bytes, content_type: str, timeout: int = 300) -> str:
        self.uploads.append((bucket_uid, filename, content, content_type))
        return f"file-{len(self.uploads)}"

    def post_task_progress(self, task_id, report, timeout: int = 10) -> _Response:  # type: ignore[no-untyped-def]
        return _Response()

    def post_task_result(self, report, timeout: int = 60) -> _Response:  # type: ignore[no-untyped-def]
        self.result = report
        return _Response()


@pytest.fixture
def stub_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    model_file = tmp_path / "model.onnx"
    model_file.write_bytes(b"stub")
    monkeypatch.setattr(bgremove, "model_path", lambda name, settings=None: model_file)
    monkeypatch.setattr(bgremove, "_session", lambda path, cfg: object())

    def fake_predict(sess: object, img: Image.Image, spec: object) -> np.ndarray:
        alpha = np.zeros((img.height, img.width), np.float32)
        alpha[img.height // 4 : img.height // 2, img.width // 4 : img.width // 2] = 1.0
        return alpha

    monkeypatch.setattr(bgremove, "predict_alpha", fake_predict)


def _execute(data: Path, payload: dict[str, Any], bucket: str | None = "out") -> _FakeTransport:
    transport = _FakeTransport()
    execute_bgremove(transport, TaskId(id="t1", cap=CAP), CAP, payload, data, output_bucket=bucket)  # type: ignore[arg-type]
    return transport


def test_executor_uploads_cutouts_and_masks(stub_model: None, tmp_path: Path) -> None:
    data = tmp_path / "data"
    data.mkdir()
    Image.new("RGB", (80, 120), (9, 9, 9)).save(data / "hero.jpg")

    transport = _execute(data, {"crop": True, "return_mask": True})

    assert transport.result is not None and transport.result.status.status == "success"
    out = transport.result.output
    assert out["model"] == "bgremove-birefnet-general"
    assert out["background"] == "transparent"
    image = out["images"][0]
    assert image["filename"] == "hero.png" and image["file_uid"] == "file-1"
    assert image["mask_filename"] == "hero.mask.png" and image["mask_file_uid"] == "file-2"
    assert (image["width"], image["height"]) == (20, 30)
    assert [u[1] for u in transport.uploads] == ["hero.png", "hero.mask.png"]


def test_executor_requires_output_bucket(stub_model: None, tmp_path: Path) -> None:
    Image.new("RGB", (10, 10)).save(tmp_path / "a.png")
    transport = _execute(tmp_path, {}, bucket=None)
    assert transport.result is not None and transport.result.status.status == "failure"
    assert "output_bucket" in transport.result.output["error"]


def test_executor_reports_missing_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(bgremove, "model_path", lambda name, settings=None: None)
    Image.new("RGB", (10, 10)).save(tmp_path / "a.png")
    transport = _execute(tmp_path, {})
    assert transport.result is not None and transport.result.status.status == "failure"
    assert "onnx-models-prepare" in transport.result.output["error"]


def test_executor_rejects_unknown_model(tmp_path: Path) -> None:
    transport = _FakeTransport()
    cap = "onnx.bgremove.nope"
    execute_bgremove(transport, TaskId(id="t1", cap=cap), cap, {}, tmp_path, output_bucket="out")  # type: ignore[arg-type]
    assert transport.result is not None and transport.result.status.status == "failure"
    assert "Unknown background-removal model" in transport.result.output["error"]
