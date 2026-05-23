"""Capability rescan + push to server (for slavemode and similar)."""
from __future__ import annotations

import logging
from typing import Callable

from offloadmq_agent.cap_policy import compute_registration_caps
from offloadmq_agent.capabilities_sync import detect_capabilities
from offloadmq_agent.settings_util import load_agent_settings
from offloadmq_agent.systeminfo import calculate_tier, collect_system_info
from offloadmq_agent.transport_exec import AgentTransport

logger = logging.getLogger(__name__)


def rescan_and_push(
    transport: AgentTransport,
    log_fn: Callable[[str], None] | None = None,
) -> list[str]:
    if log_fn is None:
        log_fn = logger.info
    cfg = load_agent_settings()
    caps = detect_capabilities(log_fn)
    caps = compute_registration_caps(cfg, caps, log_fn)
    tier = int(cfg.get("tier") or calculate_tier(collect_system_info()))
    capacity = int(cfg.get("max_concurrent", cfg.get("capacity", 1)) or 1)
    display_name = cfg.get("display_name") or cfg.get("displayName")
    if hasattr(transport, "update_agent_info"):
        transport.update_agent_info(  # type: ignore[attr-defined]
            caps,
            tier,
            capacity,
            display_name=str(display_name) if display_name else None,
        )
    return caps
