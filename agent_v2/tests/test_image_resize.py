"""Unit tests for the built-in image_resize capability."""
from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import Image

from offloadmq_agent.cap_policy import classify_capabilities, compute_registration_caps
from offloadmq_agent.capabilities_sync import check_image_resize
from offloadmq_agent.exec.image_resize import (
    RESAMPLING_METHODS,
    ResizeSpec,
    _resize_one,
    _select_inputs,
    capability_string,
    execute_image_resize,
)
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.wire import TaskId, TaskResultReport


def _write_image(path: Path, size: tuple[int, int], fmt: str = "PNG") -> Path:
    Image.new("RGB", size, (128, 64, 32)).save(path, format=fmt)
    return path


# --------------------------------------------------------------------------
# registration
# --------------------------------------------------------------------------

def test_capability_string_lists_every_method() -> None:
    assert capability_string() == f"image_resize[{';'.join(RESAMPLING_METHODS)}]"


def test_check_is_always_available() -> None:
    result = check_image_resize()
    assert result.ok
    assert result.caps == [capability_string()]


def test_enabled_by_default_and_opt_out_works() -> None:
    detected = [capability_string()]

    assert classify_capabilities(detected)["regular"] == detected
    # No config at all — the capability registers anyway (opt-out tier).
    assert capability_string() in compute_registration_caps({}, list(detected))

    cfg = {"regular_disabled_caps": [capability_string()]}
    assert capability_string() not in compute_registration_caps(cfg, list(detected))


def test_routed_to_the_executor() -> None:
    from offloadmq_agent.exec.image_resize import execute_image_resize

    assert route_executor("image_resize") is execute_image_resize


# --------------------------------------------------------------------------
# spec parsing
# --------------------------------------------------------------------------

def test_fit_preserves_aspect_ratio() -> None:
    spec = ResizeSpec.from_payload({"width": 100, "height": 100})
    assert spec.target_size(400, 200) == (100, 50)


def test_fit_upscales_unless_disallowed() -> None:
    assert ResizeSpec.from_payload({"width": 800}).target_size(400, 200) == (800, 400)
    spec = ResizeSpec.from_payload({"width": 800, "allow_upscale": False})
    assert spec.target_size(400, 200) == (400, 200)


def test_exact_and_cover_use_the_box_verbatim() -> None:
    for mode in ("exact", "cover"):
        spec = ResizeSpec.from_payload({"mode": mode, "width": 100, "height": 100})
        assert spec.target_size(400, 200) == (100, 100)


def test_scale_multiplies_both_dimensions() -> None:
    assert ResizeSpec.from_payload({"scale": 0.25}).target_size(400, 200) == (100, 50)
    # Never collapses to zero.
    assert ResizeSpec.from_payload({"scale": 0.001}).target_size(400, 200) == (1, 1)


@pytest.mark.parametrize(
    "payload, message",
    [
        ({}, "Nothing to resize to"),
        ({"scale": 0}, "greater than 0"),
        ({"width": 0}, "positive integer"),
        ({"width": 10, "method": "sinc"}, "Unsupported method"),
        ({"width": 10, "mode": "squash"}, "Unsupported mode"),
        ({"mode": "cover", "width": 10}, "requires both"),
        ({"width": 10, "format": "heif"}, "Unsupported format"),
        ({"width": 10, "quality": 500}, "quality must be between"),
    ],
)
def test_rejects_bad_payloads(payload: dict, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        ResizeSpec.from_payload(payload)


# --------------------------------------------------------------------------
# input selection
# --------------------------------------------------------------------------

def test_defaults_to_every_image_in_the_bucket(tmp_path: Path) -> None:
    _write_image(tmp_path / "b.png", (10, 10))
    _write_image(tmp_path / "a.png", (10, 10))
    (tmp_path / "notes.txt").write_text("ignored")

    assert [p.name for p in _select_inputs({}, tmp_path)] == ["a.png", "b.png"]


def test_named_input_may_not_escape_the_task_directory(tmp_path: Path) -> None:
    _write_image(tmp_path / "a.png", (10, 10))
    with pytest.raises(ValueError, match="escapes the task directory"):
        _select_inputs({"input_image": "../secret.png"}, tmp_path)


def test_missing_named_input_is_reported(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        _select_inputs({"input_image": "nope.png"}, tmp_path)


def test_no_images_is_reported(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("ignored")
    with pytest.raises(ValueError, match="No input images"):
        _select_inputs({}, tmp_path)


# --------------------------------------------------------------------------
# resizing
# --------------------------------------------------------------------------

def test_resize_keeps_the_source_format(tmp_path: Path) -> None:
    src = _write_image(tmp_path / "photo.jpg", (400, 200), fmt="JPEG")
    content, meta = _resize_one(src, ResizeSpec.from_payload({"width": 100}))

    assert (meta["width"], meta["height"]) == (100, 50)
    assert (meta["original_width"], meta["original_height"]) == (400, 200)
    assert meta["filename"] == "photo.jpg"
    assert meta["content_type"] == "image/jpeg"
    with Image.open(io.BytesIO(content)) as out:
        assert out.size == (100, 50)
        assert out.format == "JPEG"


def test_resize_can_transcode(tmp_path: Path) -> None:
    src = _write_image(tmp_path / "photo.png", (400, 200))
    payload = {"width": 100, "format": "jpeg", "quality": 70}
    content, meta = _resize_one(src, ResizeSpec.from_payload(payload))

    assert meta["filename"] == "photo.jpg"
    assert meta["content_type"] == "image/jpeg"
    with Image.open(io.BytesIO(content)) as out:
        assert out.format == "JPEG"


def test_cover_crops_to_fill_the_box(tmp_path: Path) -> None:
    src = _write_image(tmp_path / "photo.png", (400, 200))
    payload = {"mode": "cover", "width": 100, "height": 100}
    content, meta = _resize_one(src, ResizeSpec.from_payload(payload))

    assert (meta["width"], meta["height"]) == (100, 100)
    with Image.open(io.BytesIO(content)) as out:
        assert out.size == (100, 100)


@pytest.mark.parametrize("method", RESAMPLING_METHODS)
def test_every_advertised_method_runs(tmp_path: Path, method: str) -> None:
    src = _write_image(tmp_path / "photo.png", (64, 64))
    _, meta = _resize_one(src, ResizeSpec.from_payload({"width": 32, "method": method}))
    assert (meta["width"], meta["height"]) == (32, 32)


def test_rgba_png_survives_jpeg_transcode(tmp_path: Path) -> None:
    src = tmp_path / "alpha.png"
    Image.new("RGBA", (40, 40), (10, 20, 30, 128)).save(src)
    content, _ = _resize_one(
        src, ResizeSpec.from_payload({"width": 20, "format": "jpeg"})
    )
    with Image.open(io.BytesIO(content)) as out:
        assert out.mode == "RGB"


# --------------------------------------------------------------------------
# executor end to end (fake transport)
# --------------------------------------------------------------------------

class _Response:
    status_code = 200
    content = b""

    def raise_for_status(self) -> None:
        pass


class _FakeTransport:
    """Minimal AgentTransport: records uploads and the final result report."""

    def __init__(self) -> None:
        self.uploads: list[tuple[str, str, int, str]] = []
        self.result: TaskResultReport | None = None

    def upload_file(
        self, bucket_uid: str, filename: str, content: bytes, content_type: str,
        timeout: int = 300,
    ) -> str:
        self.uploads.append((bucket_uid, filename, len(content), content_type))
        return f"file-{len(self.uploads)}"

    def post_task_progress(self, task_id, report, timeout: int = 10) -> _Response:  # type: ignore[no-untyped-def]
        return _Response()

    def post_task_result(self, report, timeout: int = 60) -> _Response:  # type: ignore[no-untyped-def]
        self.result = report
        return _Response()

    def get(self, *segments: str, timeout: int = 60) -> _Response:
        raise AssertionError("image_resize must not make GET calls")

    def post(self, *segments: str, json_body: dict, timeout: int = 60) -> _Response:
        raise AssertionError("image_resize must not make POST calls")


def _execute(tmp_path: Path, payload: dict, bucket: str | None = "out-bucket") -> _FakeTransport:
    transport = _FakeTransport()
    execute_image_resize(
        transport,  # type: ignore[arg-type]
        TaskId(id="task-1", cap="image_resize"),
        "image_resize",
        payload,
        tmp_path,
        output_bucket=bucket,
    )
    return transport


def test_executor_uploads_every_image(tmp_path: Path) -> None:
    _write_image(tmp_path / "a.png", (400, 200))
    _write_image(tmp_path / "b.png", (100, 100))

    transport = _execute(tmp_path, {"width": 50, "method": "bicubic"})

    assert transport.result is not None
    assert transport.result.status.status == "success"
    output = transport.result.output
    assert output["image_count"] == 2
    assert output["output_bucket"] == "out-bucket"
    assert output["method"] == "bicubic"
    assert [img["file_uid"] for img in output["images"]] == ["file-1", "file-2"]
    assert [u[1] for u in transport.uploads] == ["a.png", "b.png"]


def test_executor_fails_without_an_output_bucket(tmp_path: Path) -> None:
    _write_image(tmp_path / "a.png", (400, 200))

    transport = _execute(tmp_path, {"width": 50}, bucket=None)

    assert transport.result is not None
    assert transport.result.status.status == "failure"
    assert not transport.uploads
    assert "output_bucket" in transport.result.output["error"]


def test_executor_fails_on_a_bad_payload(tmp_path: Path) -> None:
    _write_image(tmp_path / "a.png", (400, 200))

    transport = _execute(tmp_path, {"method": "sinc", "width": 50})

    assert transport.result is not None
    assert transport.result.status.status == "failure"
    assert "Unsupported method" in transport.result.output["error"]
