"""Windows HKCU registry autostart management."""

import sys
from typing import Callable

_WIN_REG_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_WIN_REG_NAME = "OffloadAgent"


def available() -> bool:
    return sys.platform == "win32"


def read_value() -> str | None:
    """Return the raw registry value for the OffloadAgent startup entry, or None if absent."""
    if sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_REG_KEY, 0, winreg.KEY_READ) as key:
                value, _ = winreg.QueryValueEx(key, _WIN_REG_NAME)
                return str(value)
        except FileNotFoundError:
            return None
        except OSError as exc:
            return f"ERROR: {exc}"
    return None


def enabled(log: Callable[[str], None] | None = None) -> bool:
    value = read_value()
    if value is not None and log:
        log(f"[startup] Registry entry found: {value}")
    return value is not None


def _get_exe_path() -> str | None:
    """Return the binary to register for autostart, or None if not resolvable."""
    if getattr(sys, "frozen", False):
        return sys.executable
    import shutil
    return shutil.which("omq-gui") or shutil.which("omq-gui.exe")


def _build_startup_cmd(exe_path: str) -> str:
    """Build the registry Run command for Windows startup.

    Uses Start-Process to launch omq-gui detached with an explicit WorkingDirectory.
    A 10-second sleep lets network/user-profile init finish before the app starts.
    """
    from pathlib import Path
    work_dir = str(Path(exe_path).parent)
    return (
        f'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command '
        f'"Start-Sleep -Seconds 10; '
        f'Start-Process -FilePath \'{exe_path}\' '
        f'-WorkingDirectory \'{work_dir}\'"'
    )


def set_enabled(enable: bool, log: Callable[[str], None]) -> None:
    if sys.platform == "win32":
        import winreg
        exe_path = _get_exe_path()
        log(f"[startup] exe={exe_path!r}  frozen={getattr(sys, 'frozen', False)}")
        if enable and not exe_path:
            log("[startup] ERROR: omq-gui not found in PATH; startup not configured")
            return
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_REG_KEY, 0, winreg.KEY_SET_VALUE) as key:
                if enable:
                    cmd = _build_startup_cmd(exe_path)  # type: ignore[arg-type]
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
