import os
from pathlib import Path
import platform
from typing import Any
from offloadmq_agent.wire import TaskId
from .updn import FileReference


def pick_directory(task_id: TaskId) -> Path:
    """
    Returns path to a new directory for the given task_id.
    Creates all necessary directories if they don't exist.

    Args:
        task_id: Unique identifier for the task

    Returns:
        Path object pointing to the created directory
    """
    system = platform.system()

    if system == "Windows":
        # Use AppData/Local on Windows
        base_path = Path(
            os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")
        )
    elif system == "Darwin":  # macOS
        # Use Application Support on macOS
        base_path = Path.home() / "Library" / "Application Support"
    else:  # Linux and other Unix-like systems
        # Use .local/share on Linux (XDG Base Directory specification)
        base_path = Path(
            os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
        )

    # Create the full path
    dir_path = base_path / "offload_agent" / "runs" / str(task_id.id)

    # Create all directories in the path if they don't exist
    dir_path.mkdir(parents=True, exist_ok=True)

    return dir_path


def resolve_bucket_file_path(data_path: Path, original_name: str) -> Path:
    """Resolve a bucket file's client-supplied ``original_name`` under ``data_path``.

    ``original_name`` comes from bucket metadata recorded at upload time and is
    ultimately client-controlled, so it must not be trusted to stay inside the
    task's data directory. Raises ValueError if it would escape.
    """
    root = data_path.resolve()
    candidate = (data_path / original_name).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError(f"Bucket file name {original_name!r} escapes the task directory")
    return candidate


def parse_file_reference(raw: dict[str, Any]) -> FileReference:
    """
    Convert a raw camelCase payload dict into a FileReference instance.
    Unknown fields are ignored gracefully.
    Raises ValueError if required 'path' field is missing.
    """
    path = raw.get("path")
    if not path:
        raise ValueError("FileReference must have a 'path' field")

    return FileReference(
        path=path,
        git_clone=raw.get("gitClone"),
        s3_file=raw.get("s3File"),
        get=raw.get("get"),
        post=raw.get("post"),
        request=raw.get("request"),
        http_login=raw.get("httpLogin"),
        http_password=raw.get("httpPassword"),
        http_auth_header=raw.get("httpAuthHeader"),
        custom_header=raw.get("customHeader"),
        custom_auth=raw.get("customAuth"),
    )
