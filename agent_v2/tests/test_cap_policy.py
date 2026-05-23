"""Unit tests for capability policy."""
from offloadmq_agent.cap_policy import classify_capabilities, compute_registration_caps


def test_classify_sensitive() -> None:
    out = classify_capabilities(["docker.any", "llm.foo", "unknown.cap"])
    assert "docker.any" in out["sensitive"]
    assert "llm.foo" in out["regular"]
    assert "unknown.cap" in out["unknown"]


def test_compute_registration_opt_out() -> None:
    cfg: dict = {
        "regular_disabled_caps": ["debug.echo"],
        "sensitive_allowed_caps": [],
        "slavemode_allowed_caps": [],
    }
    detected = ["debug.echo", "llm.test", "docker.any"]
    caps = compute_registration_caps(cfg, detected)
    assert "llm.test" in caps
    assert "debug.echo" not in caps
    assert "docker.any" not in caps
