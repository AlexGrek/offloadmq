import os
from pathlib import Path
import platform
from ..models import TaskId
from .updn import FileReference


def pick_directory(task_id: TaskId):
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
    dir_path = base_path / "offload_client" / "runs" / str(task_id.id)

    # Create all directories in the path if they don't exist
    dir_path.mkdir(parents=True, exist_ok=True)

    return dir_path


def parse_file_reference(raw: dict) -> FileReference:
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
