"""Windows HKCU registry autostart management."""

import sys
from typing import Callable

_WIN_REG_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_WIN_REG_NAME = "OffloadAgent"


def available() -> bool:
    return sys.platform == "win32"


def read_value() -> str | None:
    """Return the raw registry value for the OffloadAgent startup entry, or None if absent."""
    if sys.platform != "win32":
        return None
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_REG_KEY, 0, winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, _WIN_REG_NAME)
            return str(value)
    except FileNotFoundError:
        return None
    except OSError as exc:
        return f"ERROR: {exc}"


def enabled(log: Callable[[str], None] | None = None) -> bool:
    value = read_value()
    if value is not None and log:
        log(f"[startup] Registry entry found: {value}")
    return value is not None


def _build_startup_cmd(exe_path: str) -> str:
    """
    Build the registry Run command for Windows startup.

    Uses Start-Process to launch the exe detached (PowerShell exits immediately after
    spawning it), with an explicit WorkingDirectory so the exe finds its config file
    regardless of what CWD Windows assigns at login.
    """
    from pathlib import Path
    work_dir = str(Path(exe_path).parent)
    return (
        f'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command '
        f'"Start-Sleep -Seconds 10; '
        f'Start-Process -FilePath \'{exe_path}\' -WorkingDirectory \'{work_dir}\'"'
    )


def set_enabled(enable: bool, log: Callable[[str], None]) -> None:
    if not available():
        return
    import winreg
    frozen = getattr(sys, "frozen", False)
    exe_path = sys.executable
    log(f"[startup] sys.executable={exe_path!r}  frozen={frozen}")
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_REG_KEY, 0, winreg.KEY_SET_VALUE) as key:
            if enable:
                cmd = _build_startup_cmd(exe_path)
                winreg.SetValueEx(key, _WIN_REG_NAME, 0, winreg.REG_SZ, cmd)
                log(f"[startup] Wrote registry value: {cmd}")
            else:
                try:
                    winreg.DeleteValue(key, _WIN_REG_NAME)
                    log("[startup] Deleted registry entry (startup disabled)")
                except FileNotFoundError:
                    log("[startup] No registry entry to delete (already absent)")
    except OSError as exc:
        log(f"[startup] ERROR writing registry: {exc}")
