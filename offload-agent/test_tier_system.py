#!/usr/bin/env python3
"""Test script for 3-tier capability system."""

import sys
from pathlib import Path

# Add app directory to path
sys.path.insert(0, str(Path(__file__).parent))

from app.capabilities import (
    classify_capabilities,
    is_sensitive_capability,
    is_regular_capability,
    compute_registration_caps,
)


def test_classification():
    """Test capability tier classification."""
    print("Testing capability classification...")

    test_caps = [
        "debug.echo",
        "shell.bash",
        "shellcmd.bash",
        "docker.any",
        "docker.python-slim",
        "llm.qwen3:8b",
        "llm.mistral[vision;tools]",
        "imggen.wan-2.1-outpaint[txt2img;img2img]",
        "tts.kokoro[voice1;voice2]",
        "custom.mycap",
    ]

    classified = classify_capabilities(test_caps)

    print(f"  Regular: {classified['regular']}")
    print(f"  Sensitive: {classified['sensitive']}")
    print(f"  Unknown: {classified['unknown']}")

    # Verify classification
    assert is_regular_capability("debug.echo")
    assert is_regular_capability("llm.qwen3:8b")
    assert is_regular_capability("imggen.wan-2.1-outpaint[txt2img;img2img]")
    assert is_regular_capability("custom.mycap")

    assert is_sensitive_capability("shell.bash")
    assert is_sensitive_capability("shellcmd.bash")
    assert is_sensitive_capability("docker.any")

    assert not is_sensitive_capability("debug.echo")
    assert not is_regular_capability("docker.any")

    print("  ✓ Classification tests passed")


def test_compute_registration_caps():
    """Test capability computation with tier system."""
    print("\nTesting compute_registration_caps...")

    detected = [
        "debug.echo",
        "shell.bash",
        "docker.any",
        "llm.qwen3:8b",
        "imggen.workflow1[txt2img]",
        "custom.mycap",
    ]

    # Test 1: Fresh config (no migration needed)
    print("  Test 1: Fresh config with tier system")
    cfg1 = {
        "sensitive-allowed-caps": ["docker.any"],  # Only allow docker
        "regular-disabled-caps": ["debug.echo"],   # Disable debug
    }

    caps1 = compute_registration_caps(cfg1, detected, log_fn=lambda msg: print(f"    {msg}"))

    print(f"  Registered caps: {caps1}")
    assert "docker.any" in caps1, "Allowed sensitive cap should be registered"
    assert "shell.bash" not in caps1, "Non-allowed sensitive cap should NOT be registered"
    assert "llm.qwen3:8b" in caps1, "Regular cap should be registered by default"
    assert "debug.echo" not in caps1, "Disabled regular cap should NOT be registered"
    assert "imggen.workflow1[txt2img]" in caps1, "Imggen should be registered by default"
    assert "custom.mycap" in caps1, "Custom cap should be registered by default"
    print("  ✓ Fresh config test passed")

    # Test 2: Legacy config migration
    print("\n  Test 2: Legacy config migration")
    cfg2 = {
        "capabilities": [
            "debug.echo",
            "docker.any",
            "llm.qwen3:8b",
        ]
    }

    caps2 = compute_registration_caps(cfg2, detected, log_fn=lambda msg: print(f"    {msg}"))

    print(f"  Registered caps: {caps2}")
    print(f"  Config after migration: sensitive={cfg2.get('sensitive-allowed-caps')}, disabled={cfg2.get('regular-disabled-caps')}")

    assert "docker.any" in caps2, "Previously selected sensitive cap should be allowed"
    assert "shell.bash" not in caps2, "Previously NOT selected sensitive cap should NOT be allowed"
    assert "llm.qwen3:8b" in caps2, "Previously selected regular cap should be enabled"
    assert "imggen.workflow1[txt2img]" not in caps2, "Previously NOT selected regular cap should be disabled"
    assert "custom.mycap" not in caps2, "Previously NOT selected custom cap should be disabled"

    # Verify migration created new keys
    assert "sensitive-allowed-caps" in cfg2
    assert "regular-disabled-caps" in cfg2
    assert "docker.any" in cfg2["sensitive-allowed-caps"]
    assert "imggen.workflow1[txt2img]" in cfg2["regular-disabled-caps"]
    assert "custom.mycap" in cfg2["regular-disabled-caps"]

    print("  ✓ Legacy migration test passed")

    # Test 3: Empty config (all regular enabled, all sensitive disabled)
    print("\n  Test 3: Empty config (defaults)")
    cfg3 = {}

    caps3 = compute_registration_caps(cfg3, detected, log_fn=lambda msg: print(f"    {msg}"))

    print(f"  Registered caps: {caps3}")
    assert "shell.bash" not in caps3, "Sensitive caps should be disabled by default"
    assert "docker.any" not in caps3, "Sensitive caps should be disabled by default"
    assert "llm.qwen3:8b" in caps3, "Regular caps should be enabled by default"
    assert "debug.echo" in caps3, "Regular caps should be enabled by default"
    assert "imggen.workflow1[txt2img]" in caps3, "Regular caps should be enabled by default"
    assert "custom.mycap" in caps3, "Custom caps should be enabled by default"
    print("  ✓ Empty config test passed")


if __name__ == "__main__":
    try:
        test_classification()
        test_compute_registration_caps()
        print("\n✅ All tests passed!")
    except AssertionError as e:
        print(f"\n❌ Test failed: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
