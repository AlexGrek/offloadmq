"""Workspace (working directory) resolution and cleanup for shell jobs."""
from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from offloadmq_agent.data.fs_utils import pick_directory
from offloadmq_agent.wire import TaskId

from .subst import SubstContext, SubstitutionError, substitute

logger = logging.getLogger(__name__)

DEFAULT_WORKSPACE_ROOT = Path.home() / ".offload-agent" / "shell-workspaces"
CLEANUP_MODES = ("auto", "always", "on_success", "never")


class WorkspaceError(ValueError):
    pass


@dataclass
class Workspace:
    path: Path
    created: bool  # this task created the directory (only then may it be deleted)
    cleanup: str  # always | on_success | never (``auto`` already resolved)

    def remove(self, succeeded: bool) -> bool:
        """Delete the directory if policy allows. Returns True when removed."""
        if not self.created or self.cleanup == "never":
            return False
        if self.cleanup == "on_success" and not succeeded:
            return False
        if self.path in (Path.home(), Path(self.path.anchor)):
            return False
        shutil.rmtree(self.path, ignore_errors=True)
        return True


def workspace_root(settings: Mapping[str, Any]) -> Path:
    raw = str(settings.get("shell_workspace_root") or "").strip()
    return Path(raw).expanduser() if raw else DEFAULT_WORKSPACE_ROOT


def resolve_workspace(
    spec: Any,
    cleanup: Any,
    ctx: SubstContext,
    env: Mapping[str, str],
    settings: Mapping[str, Any],
    task_id: TaskId,
) -> Workspace:
    cleanup = cleanup or "auto"
    if cleanup not in CLEANUP_MODES:
        raise WorkspaceError(f"'cleanup' must be one of {', '.join(CLEANUP_MODES)}")

    if spec is None or spec == "":
        # Same per-task directory every routed executor gets.
        path = pick_directory(task_id)
        return Workspace(path, created=True, cleanup="always" if cleanup == "auto" else cleanup)

    if not isinstance(spec, str):
        raise WorkspaceError("'workspace' must be a string")
    try:
        expanded = substitute(spec, ctx, env)
    except SubstitutionError as exc:
        raise WorkspaceError(f"workspace: {exc}") from None
    if not expanded.strip():
        raise WorkspaceError("workspace resolved to an empty path")

    root = workspace_root(settings)
    path = Path(expanded).expanduser()
    if not path.is_absolute():
        path = root / path
    path = path.resolve()

    if settings.get("shell_restrict_workspace"):
        real_root = root.resolve()
        if path == real_root or not path.is_relative_to(real_root):
            raise WorkspaceError(
                f"workspace {path} is outside the agent's workspace root {real_root} "
                "(shell_restrict_workspace is on)"
            )

    if path.exists() and not path.is_dir():
        raise WorkspaceError(f"workspace {path} exists and is not a directory")
    created = not path.exists()
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise WorkspaceError(f"cannot create workspace {path}: {exc}") from None

    if cleanup == "auto":
        cleanup = "always" if "${rand" in spec else "never"
    return Workspace(path, created=created, cleanup=cleanup)
