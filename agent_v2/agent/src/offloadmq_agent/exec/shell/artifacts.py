"""Output artifacts: workspace globs → files uploaded to the task's output bucket."""
from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path, PurePosixPath
from typing import Any, Callable

MAX_ARTIFACTS = 256
WHEN_MODES = ("on_success", "always")


class ArtifactError(ValueError):
    pass


def validate_patterns(raw: Any) -> list[str]:
    if raw is None or raw == "":
        return []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        raise ArtifactError("'artifacts' must be a list of glob patterns")
    patterns: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise ArtifactError("artifact patterns must be non-empty strings")
        pattern = item.strip().replace("\\", "/")
        pure = PurePosixPath(pattern)
        if pure.is_absolute() or ".." in pure.parts or (len(pattern) > 1 and pattern[1] == ":"):
            raise ArtifactError(f"artifact pattern {item!r} must be relative to the workspace")
        patterns.append(pattern)
    return patterns


def collect(workspace: Path, patterns: list[str]) -> tuple[list[Path], list[str]]:
    """Expand patterns under ``workspace``.

    Returns (files, patterns that matched nothing). A directory match contributes
    every file under it; anything resolving outside the workspace (symlinks) is
    skipped.
    """
    root = workspace.resolve()
    files: list[Path] = []
    seen: set[Path] = set()
    missing: list[str] = []

    def add(path: Path) -> bool:
        """True when ``path`` is (or already was) an artifact."""
        try:
            real = path.resolve()
        except OSError:
            return False
        if not real.is_relative_to(root) or not real.is_file():
            return False
        if real not in seen:
            seen.add(real)
            files.append(real)
        return True

    for pattern in patterns:
        matched = False
        for hit in sorted(root.glob(pattern)):
            if hit.is_dir() and not hit.is_symlink():
                for child in sorted(hit.rglob("*")):
                    matched = add(child) or matched
            else:
                matched = add(hit) or matched
            if len(files) > MAX_ARTIFACTS:
                raise ArtifactError(f"more than {MAX_ARTIFACTS} artifact files matched")
        if not matched:
            missing.append(pattern)
    return files, missing


def upload_all(
    workspace: Path,
    files: list[Path],
    bucket_uid: str,
    upload: Callable[[str, str, bytes, str], str],
    on_uploaded: Callable[[str, int], None] | None = None,
) -> list[dict[str, Any]]:
    """Upload ``files`` (named by workspace-relative path). ``upload(bucket, name, data, type)``."""
    root = workspace.resolve()
    results: list[dict[str, Any]] = []
    for path in files:
        rel = path.resolve().relative_to(root).as_posix()
        data = path.read_bytes()
        content_type = mimetypes.guess_type(rel)[0] or "application/octet-stream"
        file_uid = upload(bucket_uid, rel, data, content_type)
        results.append({
            "path": rel,
            "file_uid": file_uid,
            "bucket_uid": bucket_uid,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "content_type": content_type,
        })
        if on_uploaded:
            on_uploaded(rel, len(data))
    return results
