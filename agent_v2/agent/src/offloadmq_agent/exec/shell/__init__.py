"""``shell.*`` capability family — see docs/shell-api.md."""
from __future__ import annotations

from .executor import execute_shell_job, prepare_shell_job
from .shells import detect_shells, shell_capabilities

__all__ = ["detect_shells", "execute_shell_job", "prepare_shell_job", "shell_capabilities"]
