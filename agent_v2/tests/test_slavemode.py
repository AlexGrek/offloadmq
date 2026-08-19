"""Regression tests for the slavemode allow-list and executor wiring.

Each test here covers a defect that made slavemode silently unusable: an
unimportable module, a config key the executor read but nothing ever wrote,
and a default-seeding rule that undid the operator's "Deny all".
"""
from __future__ import annotations

import json
from pathlib import Path

from offloadmq_agent import settings_util
from offloadmq_agent.cap_policy import compute_registration_caps
from offloadmq_agent.exec.route import route_executor
from offloadmq_agent.slavemode_policy import (
    ALL_SLAVEMODE_CAPS,
    is_cap_allowed,
    slavemode_caps_for_registration,
)
from offloadmq_core.settings import Settings, save_settings


def test_slavemode_executor_is_importable_and_routed() -> None:
    """route_executor must not raise — a bad import here black-holes every task."""
    fn = route_executor("slavemode.force-rescan")
    assert fn is not None
    assert fn.__name__ == "execute_slavemode"


def test_onnx_models_importable() -> None:
    """onnx_models backs both slavemode onnx caps and onnx.* detection."""
    from offloadmq_agent.capabilities_sync import check_onnx
    from offloadmq_agent.onnx_models import models_dir

    assert isinstance(models_dir(), Path)
    check_onnx()  # must not raise


def test_advertised_caps_are_executable(tmp_path: Path, monkeypatch) -> None:
    """Anything registration advertises must pass the executor's gate.

    These used to read different config keys, so every advertised slavemode cap
    was rejected at execution time with "not enabled".
    """
    cfg_file = tmp_path / ".offloadmq-agent.json"
    save_settings(Settings(slavemode_allowed_caps=list(ALL_SLAVEMODE_CAPS)), cfg_file)
    monkeypatch.setattr(settings_util, "SETTINGS_FILE", cfg_file)

    from offloadmq_agent.exec.slavemode import _is_allowed

    raw = json.loads(cfg_file.read_text())
    advertised = slavemode_caps_for_registration(raw)
    assert advertised == sorted(ALL_SLAVEMODE_CAPS)
    for cap in advertised:
        assert _is_allowed(cap), f"{cap} advertised but refused by executor"


def test_non_allowlisted_cap_is_refused(tmp_path: Path, monkeypatch) -> None:
    cfg_file = tmp_path / ".offloadmq-agent.json"
    save_settings(Settings(slavemode_allowed_caps=["slavemode.force-rescan"]), cfg_file)
    monkeypatch.setattr(settings_util, "SETTINGS_FILE", cfg_file)

    from offloadmq_agent.exec.slavemode import _is_allowed

    assert _is_allowed("slavemode.force-rescan")
    assert not _is_allowed("slavemode.ollama-pull")
    assert not _is_allowed("slavemode.not-a-real-cap")


def test_legacy_hyphenated_key_still_honoured() -> None:
    """v1 configs imported verbatim must keep working."""
    cfg = {"slavemode-allowed-caps": ["slavemode.force-rescan"]}
    assert slavemode_caps_for_registration(cfg) == ["slavemode.force-rescan"]
    assert is_cap_allowed(cfg, "slavemode.force-rescan")


def test_deny_all_survives_rescan() -> None:
    """An explicit empty allow-list must not be repopulated by Ollama defaults."""
    cfg = Settings(
        slavemode_allowed_caps=[],
        onnx_slavemode_initialized=True,
        ollama_slavemode_initialized=True,
    ).model_dump()
    caps = compute_registration_caps(cfg, ["llm.qwen3:8b", "debug.echo"])
    assert [c for c in caps if c.startswith("slavemode.")] == []
    assert cfg["slavemode_allowed_caps"] == []


def test_first_launch_with_ollama_seeds_defaults_once() -> None:
    cfg = Settings(onnx_slavemode_initialized=True).model_dump()
    caps = compute_registration_caps(cfg, ["llm.qwen3:8b"])
    assert sorted(c for c in caps if c.startswith("slavemode.")) == [
        "slavemode.ollama-delete",
        "slavemode.ollama-list",
        "slavemode.ollama-pull",
    ]
    assert cfg["ollama_slavemode_initialized"] is True

    # Operator then denies all; the next rescan must respect that.
    cfg["slavemode_allowed_caps"] = []
    caps = compute_registration_caps(cfg, ["llm.qwen3:8b"])
    assert [c for c in caps if c.startswith("slavemode.")] == []


def test_seeding_preserves_preexisting_choice() -> None:
    """Upgrading an install that predates the flag must not widen its allow-list."""
    cfg = Settings(
        slavemode_allowed_caps=["slavemode.force-rescan"],
        onnx_slavemode_initialized=True,
    ).model_dump()
    caps = compute_registration_caps(cfg, ["llm.qwen3:8b"])
    assert [c for c in caps if c.startswith("slavemode.")] == ["slavemode.force-rescan"]
    assert cfg["ollama_slavemode_initialized"] is True
