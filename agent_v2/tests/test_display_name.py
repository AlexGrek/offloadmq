from __future__ import annotations

from offloadmq_agent.systeminfo import (
    compute_default_display_name,
    effective_display_name,
)


def test_effective_display_name_uses_custom_when_set() -> None:
    sysinfo = {"cpuModel": "Intel Xeon", "totalMemoryGb": 64}
    assert effective_display_name("  My Node  ", sysinfo) == "My Node"


def test_effective_display_name_falls_back_to_hardware() -> None:
    sysinfo = {
        "cpuModel": "Apple M3 Pro",
        "totalMemoryGb": 16,
        "gpu": {"vendor": "Apple", "model": "Apple M3 Pro", "vramGb": 0},
    }
    assert effective_display_name("", sysinfo) == compute_default_display_name(sysinfo)
    assert effective_display_name(None, sysinfo) == compute_default_display_name(sysinfo)


def test_compute_default_display_name_includes_discrete_gpu() -> None:
    sysinfo = {
        "cpuModel": "Intel Core i9-13900K",
        "totalMemoryGb": 48,
        "gpu": {
            "vendor": "NVIDIA",
            "model": "NVIDIA GeForce RTX 4090",
            "vramGb": 24,
        },
    }
    name = compute_default_display_name(sysinfo)
    assert "RTX" in name
    assert "48GB" in name
    assert len(name) <= 50
