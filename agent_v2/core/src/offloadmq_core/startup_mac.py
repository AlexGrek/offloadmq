"""macOS LaunchAgent plist management for autostart."""

import os
import sys
from pathlib import Path
from typing import Callable

_LABEL = "com.offloadmq.agent"
_PLIST_PATH = os.path.expanduser(f"~/Library/LaunchAgents/{_LABEL}.plist")
_LOG_DIR = os.path.expanduser("~/Library/Logs/OffloadAgent")


def available() -> bool:
    return sys.platform == "darwin"


def read_plist() -> str | None:
    """Return the current plist file contents, or None if the file does not exist."""
    try:
        return Path(_PLIST_PATH).read_text()
    except FileNotFoundError:
        return None
    except OSError as exc:
        return f"ERROR: {exc}"


def enabled() -> bool:
    return os.path.isfile(_PLIST_PATH)


def _build_plist(exe_path: str) -> str:
    work_dir = str(Path(exe_path).parent)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe_path}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{work_dir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>{_LOG_DIR}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{_LOG_DIR}/stderr.log</string>
</dict>
</plist>
"""


def set_enabled(enable: bool, log: Callable[[str], None]) -> None:
    if not available():
        return
    import subprocess
    frozen = getattr(sys, "frozen", False)
    exe_path = sys.executable
    log(f"[startup] sys.executable={exe_path!r}  frozen={frozen}")
    if enable:
        plist = _build_plist(exe_path)
        os.makedirs(os.path.dirname(_PLIST_PATH), exist_ok=True)
        os.makedirs(_LOG_DIR, exist_ok=True)
        Path(_PLIST_PATH).write_text(plist)
        log(f"[startup] Wrote plist to {_PLIST_PATH}:\n{plist}")
        result = subprocess.run(
            ["launchctl", "load", _PLIST_PATH],
            capture_output=True, text=True,
        )
        if result.stdout:
            log(f"[startup] launchctl load stdout: {result.stdout.strip()}")
        if result.stderr:
            log(f"[startup] launchctl load stderr: {result.stderr.strip()}")
        if result.returncode != 0:
            log(f"[startup] launchctl load exited {result.returncode}")
        else:
            log("[startup] LaunchAgent loaded successfully")
    else:
        result = subprocess.run(
            ["launchctl", "unload", _PLIST_PATH],
            capture_output=True, text=True,
        )
        if result.stderr:
            log(f"[startup] launchctl unload stderr: {result.stderr.strip()}")
        try:
            Path(_PLIST_PATH).unlink()
            log(f"[startup] Deleted plist {_PLIST_PATH}")
        except FileNotFoundError:
            log("[startup] No plist to delete (already absent)")
