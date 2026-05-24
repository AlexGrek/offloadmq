"""Version string for the omq CLI.

The default below is a development sentinel. At release/build time it is
overwritten with the computed release version (e.g. ``v0.3.260``) by
``scripts/release-agent.sh`` / ``scripts/release-agent.ps1`` and the
``build-client`` GitHub workflow, so a frozen binary reports its real version.

In development (running from source) the sentinel triggers a fallback to the
installed package metadata — see ``cli_manager.main._resolve_version``.
"""
from __future__ import annotations

#: Overwritten by the release tooling; ``0.0.0.dev0`` means "not stamped".
__version__ = "0.0.0.dev0"
