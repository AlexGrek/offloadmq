"""Workflow bundle export/import (graphs + configured param maps)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from offloadmq_core import comfy_service as cs

FIXTURES = Path(__file__).parent / "fixtures" / "comfy"


@pytest.fixture
def wdir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("OFFLOAD_WORKFLOWS_DIR", str(tmp_path))
    return tmp_path


def _install(wdir: Path, rel: str, task_type: str, params: object | None) -> None:
    d = wdir / rel
    d.mkdir(parents=True)
    (d / f"{task_type}.json").write_text((FIXTURES / "lotus_depth.json").read_text())
    if params is not None:
        (d / f"{task_type}.params.json").write_text(json.dumps(params))


def test_roundtrip_preserves_graph_and_params(
    wdir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install(wdir, "my-wf", "txt2img", {"prompt": [["6", "text"]]})
    bundle = cs.export_workflow("my-wf")
    assert bundle["format"] == cs.BUNDLE_FORMAT
    assert bundle["task_types"]["txt2img"]["params"] == {"prompt": [["6", "text"]]}

    # Fresh directory standing in for another machine.
    other = wdir / "other"
    other.mkdir()
    monkeypatch.setenv("OFFLOAD_WORKFLOWS_DIR", str(other))
    res = cs.import_workflow(json.loads(json.dumps(bundle)), name="copy")
    assert res == {"name": "copy", "namespace": "", "task_types": ["txt2img"]}
    assert json.loads((other / "copy" / "txt2img.params.json").read_text()) == {
        "prompt": [["6", "text"]]
    }
    assert json.loads((other / "copy" / "txt2img.json").read_text()) == bundle["task_types"][
        "txt2img"
    ]["graph"]


def test_namespaced_export_and_unmapped_params(wdir: Path) -> None:
    _install(wdir, "img-utils/depth", "depth", None)
    bundle = cs.export_workflow("depth", "img-utils")
    assert bundle["namespace"] == "img-utils"
    assert bundle["task_types"]["depth"]["params"] is None


def test_import_refuses_existing_without_overwrite(wdir: Path) -> None:
    _install(wdir, "my-wf", "txt2img", {"seed": [["3", "seed"]]})
    bundle = cs.export_workflow("my-wf")
    with pytest.raises(FileExistsError):
        cs.import_workflow(bundle)
    bundle["task_types"]["txt2img"]["params"] = None
    cs.import_workflow(bundle, overwrite=True)
    # Replacing with an unmapped graph must not leave the stale map behind.
    assert not (wdir / "my-wf" / "txt2img.params.json").exists()


def test_import_validates_before_writing(wdir: Path) -> None:
    good = {"graph": {"1": {"class_type": "X", "inputs": {}}}, "params": None}
    bad = {"graph": {"1": {"class_type": "X", "inputs": {"a": ["9", 0]}}}, "params": None}
    bundle = {
        "format": cs.BUNDLE_FORMAT,
        "version": 1,
        "name": "wf",
        "namespace": "",
        "task_types": {"a": good, "b": bad},
    }
    with pytest.raises(ValueError):
        cs.import_workflow(bundle)
    assert not (wdir / "wf").exists()


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b.update(format="nope"),
        lambda b: b.update(version=99),
        lambda b: b.update(namespace="bogus"),
        lambda b: b.update(name="../evil"),
        lambda b: b.update(task_types={}),
        lambda b: b["task_types"].update({"x.params": b["task_types"]["t"]}),
    ],
)
def test_import_rejects_malformed_bundle(wdir: Path, mutate) -> None:  # type: ignore[no-untyped-def]
    bundle = {
        "format": cs.BUNDLE_FORMAT,
        "version": 1,
        "name": "wf",
        "namespace": "",
        "task_types": {"t": {"graph": {"1": {"class_type": "X"}}, "params": None}},
    }
    mutate(bundle)
    with pytest.raises(ValueError):
        cs.import_workflow(bundle)


def test_export_missing_workflow(wdir: Path) -> None:
    with pytest.raises(FileNotFoundError):
        cs.export_workflow("nope")


# --------------------------------------------------------------------------
# slavemode.comfy-export / slavemode.comfy-import (end to end, fake transport)
# --------------------------------------------------------------------------


class _Response:
    status_code = 200
    content = b""

    def raise_for_status(self) -> None:
        pass


class _Transport:
    def __init__(self) -> None:
        self.result = None

    def post_task_progress(self, task_id, report, timeout: int = 10) -> _Response:  # type: ignore[no-untyped-def]
        return _Response()

    def post_task_result(self, report, timeout: int = 60) -> _Response:  # type: ignore[no-untyped-def]
        self.result = report
        return _Response()


@pytest.fixture
def slave(wdir: Path, tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    from offloadmq_agent import rescan, settings_util
    from offloadmq_agent.exec.slavemode import execute_slavemode
    from offloadmq_agent.slavemode_policy import ALL_SLAVEMODE_CAPS
    from offloadmq_agent.wire import TaskId
    from offloadmq_core.settings import Settings, save_settings

    cfg_file = tmp_path_factory.mktemp("cfg") / ".offloadmq-agent.json"
    save_settings(Settings(slavemode_allowed_caps=list(ALL_SLAVEMODE_CAPS)), cfg_file)
    monkeypatch.setattr(settings_util, "SETTINGS_FILE", cfg_file)
    pushes: list[int] = []
    monkeypatch.setattr(rescan, "rescan_and_push", lambda *_a, **_k: pushes.append(1) or ["cap"])

    def run(cap: str, payload: dict):  # type: ignore[no-untyped-def]
        t = _Transport()
        execute_slavemode(t, TaskId(id="t", cap=cap), cap, payload, wdir)  # type: ignore[arg-type]
        assert t.result is not None
        return t.result, pushes

    return run


def test_slavemode_export_all_and_one(wdir: Path, slave) -> None:  # type: ignore[no-untyped-def]
    _install(wdir, "a", "txt2img", {"seed": [["3", "seed"]]})
    _install(wdir, "img-utils/depth", "depth", None)

    res, _ = slave("slavemode.comfy-export", {})
    assert res.status.status == "success"
    assert res.output["count"] == 2
    assert {(b["namespace"], b["name"]) for b in res.output["bundles"]} == {
        ("", "a"),
        ("img-utils", "depth"),
    }

    res, _ = slave("slavemode.comfy-export", {"workflow": "img-utils.depth"})
    assert [b["name"] for b in res.output["bundles"]] == ["depth"]

    res, _ = slave("slavemode.comfy-export", {"workflow": "nope"})
    assert res.status.status == "failure"


def test_slavemode_import_installs_and_rescans(wdir: Path, slave) -> None:  # type: ignore[no-untyped-def]
    _install(wdir, "src", "txt2img", {"seed": [["3", "seed"]]})
    bundle = cs.export_workflow("src")

    res, pushes = slave("slavemode.comfy-import", {"bundle": bundle, "name": "dst"})
    assert res.status.status == "success"
    assert (wdir / "dst" / "txt2img.params.json").exists()
    assert pushes == [1]

    # Second import collides; nothing more is rescanned.
    res, pushes = slave("slavemode.comfy-import", {"bundles": [bundle], "name": "dst"})
    assert res.status.status == "failure"
    assert "already exists" in res.output["error"]
    assert pushes == [1]

    res, _ = slave("slavemode.comfy-import", {"bundles": [bundle], "name": "dst", "overwrite": True})
    assert res.status.status == "success"


def test_slavemode_import_reports_partial_failure(wdir: Path, slave) -> None:  # type: ignore[no-untyped-def]
    _install(wdir, "src", "txt2img", None)
    good = cs.export_workflow("src")
    good["name"] = "good"
    res, _ = slave("slavemode.comfy-import", {"bundles": [good, {"format": "nope"}]})
    assert res.status.status == "failure"
    assert "Imported: imggen.good" in res.output["error"]
    assert (wdir / "good" / "txt2img.json").exists()


def test_slavemode_import_rejects_bad_payloads(slave) -> None:  # type: ignore[no-untyped-def]
    for payload in ({}, {"bundles": []}, {"bundles": [{}, {}], "name": "x"}):
        res, _ = slave("slavemode.comfy-import", payload)
        assert res.status.status == "failure", payload


def test_export_all_skips_corrupt_workflow(wdir: Path, slave) -> None:  # type: ignore[no-untyped-def]
    _install(wdir, "good", "txt2img", None)
    _install(wdir, "bad", "txt2img", None)
    (wdir / "bad" / "txt2img.json").write_text("{not json")

    res, _ = slave("slavemode.comfy-export", {})
    assert res.status.status == "success"
    assert [b["name"] for b in res.output["bundles"]] == ["good"]
    assert len(res.output["skipped"]) == 1 and res.output["skipped"][0].startswith("imggen.bad:")

    res, _ = slave("slavemode.comfy-export", {"workflow": "bad"})
    assert res.status.status == "failure"


def test_slavemode_import_write_error_is_a_failure_not_a_crash(
    wdir: Path, slave, monkeypatch: pytest.MonkeyPatch  # type: ignore[no-untyped-def]
) -> None:
    _install(wdir, "src", "txt2img", None)
    bundle = cs.export_workflow("src")

    def boom(self: Path, *a: object, **k: object) -> int:
        raise PermissionError("read-only")

    monkeypatch.setattr(Path, "write_text", boom)
    res, pushes = slave("slavemode.comfy-import", {"bundle": bundle, "name": "dst"})
    assert res.status.status == "failure"
    assert "read-only" in res.output["error"]
    assert pushes == []
