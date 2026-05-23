"""Update checker and self-updater for offload-agent.

Uses the dl.alexgr.space public release API (no auth required):
  GET /api/v1/pub/release/{bucket}/latest  — latest version info
  GET /rs/{bucket}/{version}/{os_arch}/{file} — binary download
"""

import json
import os
import platform
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

DL_BASE = "https://dl.alexgr.space"
BUCKET = "offload-agent"


def _os_arch() -> Optional[str]:
    m = platform.machine().lower()
    if sys.platform == "darwin":
        return "darwin-arm64" if m == "arm64" else "darwin-amd64"
    if sys.platform == "linux":
        return "linux-amd64" if m in ("x86_64", "amd64") else None
    if sys.platform == "win32":
        return "windows-amd64"
    return None


def _binary_name(os_arch: str) -> str:
    ext = ".exe" if sys.platform == "win32" else ""
    return f"offload-agent-{os_arch}{ext}"


def _download_url(os_arch: str, version: str = "latest") -> str:
    return f"{DL_BASE}/rs/{BUCKET}/{version}/{os_arch}/{_binary_name(os_arch)}"


def _fetch_latest_info() -> Dict[str, Any]:
    """Call the public release API and return the parsed JSON."""
    url = f"{DL_BASE}/api/v1/pub/release/{BUCKET}/latest"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        result: Dict[str, Any] = json.loads(resp.read())
        return result


def check_for_update(current_version: str) -> Dict[str, Any]:
    """Return update info dict.

    Keys on success: current, latest, has_update, notes, targets, download_url
    Key on failure:  error
    """
    os_arch = _os_arch()
    if not os_arch:
        return {"error": f"Unsupported platform: {sys.platform}/{platform.machine()}"}

    try:
        info = _fetch_latest_info()
    except Exception as exc:
        return {"error": f"Could not reach update server: {exc}"}

    latest: str = info.get("version", "")
    if not latest:
        return {"error": "Unexpected response from update server"}

    targets: List[str] = info.get("targets", [])
    target_available = os_arch in targets

    has_update = current_version != "dev" and latest != current_version

    return {
        "current": current_version,
        "latest": latest,
        "has_update": has_update,
        "notes": info.get("notes", ""),
        "date": info.get("date", ""),
        "targets": targets,
        "target_available": target_available,
        "download_url": _download_url(os_arch, latest) if target_available else None,
    }


def download_update(log_fn: Callable[[str], None]) -> Dict[str, Any]:
    """Download the latest binary and replace the running executable.

    Only works in frozen (PyInstaller) builds. On macOS/Linux the binary is
    atomically replaced in-place via rename. On Windows it is saved as .new
    alongside the current executable (file is locked while running).
    """
    if not getattr(sys, "frozen", False):
        return {"ok": False, "error": "Self-update only works in a packaged build, not in dev mode"}

    os_arch = _os_arch()
    if not os_arch:
        return {"ok": False, "error": f"Unsupported platform: {sys.platform}/{platform.machine()}"}

    try:
        info = _fetch_latest_info()
    except Exception as exc:
        return {"ok": False, "error": f"Could not reach update server: {exc}"}

    latest_version: str = info.get("version", "")
    if not latest_version:
        return {"ok": False, "error": "Could not determine latest version"}

    if os_arch not in info.get("targets", []):
        return {"ok": False, "error": f"No build available for {os_arch}"}

    url = _download_url(os_arch, latest_version)
    current_exe = Path(sys.executable)
    tmp_path: Optional[Path] = None

    log_fn(f"[update] Downloading {latest_version} from {url} ...")
    try:
        # Never use current_exe.parent (e.g. /usr/local/bin): it is often not writable,
        # and tempfile would fail or confuse users with paths like /usr/local/bin/tmpXXXXXX.
        with tempfile.NamedTemporaryFile(
            delete=False, suffix=".download"
        ) as tmp:
            tmp_path = Path(tmp.name)
            with urllib.request.urlopen(url, timeout=120) as resp:
                total = int(resp.headers.get("Content-Length") or 0)
                downloaded = 0
                last_pct = -1
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    tmp.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = downloaded * 100 // total
                        if pct != last_pct and pct % 10 == 0:
                            log_fn(f"[update] {pct}%  ({downloaded // 1024} KB / {total // 1024} KB)")
                            last_pct = pct

        if sys.platform != "win32":
            os.chmod(tmp_path, 0o755)

        if sys.platform == "win32":
            new_path = current_exe.with_suffix(".new")
            shutil.move(str(tmp_path), str(new_path))
            log_fn(f"[update] Saved as {new_path.name} — replace the executable manually and restart.")
            return {
                "ok": True,
                "version": latest_version,
                "restart_required": True,
                "message": f"Downloaded to {new_path.name}. Replace the current executable and restart.",
            }
        else:
            shutil.move(str(tmp_path), str(current_exe))
            log_fn(f"[update] Replaced binary with {latest_version}. Restart the agent to apply.")
            return {
                "ok": True,
                "version": latest_version,
                "restart_required": True,
                "message": f"Updated to {latest_version}. Restart the agent to apply.",
            }

    except Exception as exc:
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        log_fn(f"[update] ERROR: {exc}")
        return {"ok": False, "error": str(exc)}
