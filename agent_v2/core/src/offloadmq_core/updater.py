"""Update checker and self-updater for agent_v2 (``omq``).

Uses the dl.alexgr.space public release API (no auth required):
  GET /api/v1/pub/release/{bucket}/latest          — latest version info
  GET /rs/{bucket}/{version}/{os_arch}/{artifact}  — binary download

Artifacts are named ``omq-<os>-<arch>`` / ``omq-gui-<os>-<arch>`` (see
scripts/release-agent.sh). Self-replacement is currently **Linux + CLI only**:
the new binary is downloaded next to the running one, smoke-tested with
``--version``, and swapped in with an atomic rename. The previous binary is
kept as ``<exe>.prev`` for :func:`rollback`.

``DL_BASE_URL`` / ``DL_BUCKET`` override the source, matching the Taskfile
upgrade tasks.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from offloadmq_core.version import is_newer, is_release_version

DL_BASE = os.environ.get("DL_BASE_URL", "https://dl.alexgr.space").rstrip("/")
BUCKET = os.environ.get("DL_BUCKET", "offload-agent")

LogFn = Callable[[str], None]


class UpdateError(Exception):
    pass


@dataclass(frozen=True)
class StagedUpdate:
    version: str
    path: Path  # downloaded + verified binary, next to ``exe``
    exe: Path  # binary it will replace


def _os_arch() -> str | None:
    m = platform.machine().lower()
    arch = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(m)
    if arch is None:
        return None
    if sys.platform == "darwin":
        return f"darwin-{arch}"
    if sys.platform == "linux":
        return f"linux-{arch}"
    if sys.platform == "win32":
        return f"windows-{arch}"
    return None


def _is_gui() -> bool:
    return os.environ.get("OMQ_GUI") == "1"


def _artifact_name(os_arch: str) -> str:
    flavor = "omq-gui" if _is_gui() else "omq"
    ext = ".exe" if sys.platform == "win32" else ""
    return f"{flavor}-{os_arch}{ext}"


def _download_url(os_arch: str, version: str) -> str:
    return f"{DL_BASE}/rs/{BUCKET}/{version}/{os_arch}/{_artifact_name(os_arch)}"


def _current_exe() -> Path:
    return Path(sys.executable).resolve()


def fetch_latest_info() -> dict[str, Any]:
    url = f"{DL_BASE}/api/v1/pub/release/{BUCKET}/latest"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        result: dict[str, Any] = json.loads(resp.read())
        return result


def tls_selftest() -> None:
    """Round-trip to the release server over both HTTP stacks the agent uses.

    urllib (updater) and aiohttp (the agent's server WebSocket) load CA
    certificates independently — aiohttp at import time — so each is checked.
    Raises on failure.
    """
    import asyncio

    import aiohttp

    url = f"{DL_BASE}/api/v1/pub/release/{BUCKET}/latest"
    fetch_latest_info()

    async def _aio() -> None:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as s:
            async with s.get(url) as resp:
                resp.raise_for_status()

    asyncio.run(_aio())


def check_for_update(current_version: str) -> dict[str, Any]:
    """Return update info.

    Keys on success: current, latest, has_update, notes, date, targets,
    target_available, download_url. Key on failure: error.
    """
    os_arch = _os_arch()
    if not os_arch:
        return {"error": f"Unsupported platform: {sys.platform}/{platform.machine()}"}

    try:
        info = fetch_latest_info()
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Could not reach update server: {exc}"}

    latest = str(info.get("version", ""))
    if not latest:
        return {"error": "Unexpected response from update server"}

    targets: list[str] = list(info.get("targets", []))
    target_available = os_arch in targets
    return {
        "current": current_version,
        "latest": latest,
        "has_update": target_available and is_newer(latest, current_version),
        "notes": info.get("notes", ""),
        "date": info.get("date", ""),
        "targets": targets,
        "target_available": target_available,
        "download_url": _download_url(os_arch, latest) if target_available else None,
    }


def self_update_unsupported_reason(current_version: str) -> str | None:
    """Why this process cannot replace its own binary, or None if it can."""
    if sys.platform != "linux":
        return "Self-update is currently Linux-only"
    if _is_gui():
        return "Self-update is only supported for the omq CLI, not omq-gui"
    if not getattr(sys, "frozen", False):
        return "Self-update only works in a packaged build, not from source"
    if not is_release_version(current_version):
        return f"Running an unversioned build ({current_version})"
    if _os_arch() is None:
        return f"Unsupported architecture: {platform.machine()}"
    exe_dir = _current_exe().parent
    if not os.access(exe_dir, os.W_OK):
        return (
            f"{exe_dir} is not writable by this user — install omq somewhere "
            "user-owned (e.g. ~/.local/bin) to enable self-update"
        )
    return None


def _child_env() -> dict[str, str]:
    """Environment for launching a *different* frozen binary from a frozen one.

    Without the reset, the child's PyInstaller bootloader sees our ``_PYI_*``
    variables, believes it is our own child process, and runs out of our
    extraction dir instead of its own.
    """
    from offloadmq_agent import tls

    env = {k: v for k, v in os.environ.items() if not k.startswith(("_PYI_", "_MEI"))}
    if tls.injected:
        # Our own workaround, not the host's config: the new binary must find
        # the CA bundle by itself, exactly as it will after a systemd restart.
        env.pop("SSL_CERT_FILE", None)
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if orig is not None:
        env["LD_LIBRARY_PATH"] = orig
    else:
        env.pop("LD_LIBRARY_PATH", None)
    return env


def _run_new(binary: Path, *args: str) -> str:
    try:
        proc = subprocess.run(
            [str(binary), *args],
            capture_output=True,
            text=True,
            timeout=120,
            env=_child_env(),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise UpdateError(f"new binary failed to run: {exc}") from exc
    out = (proc.stdout + proc.stderr).strip()
    if proc.returncode != 0:
        raise UpdateError(f"new binary `{' '.join(args)}` exited {proc.returncode}: {out[-500:]}")
    return out


def _smoke_test(binary: Path, expected_version: str) -> None:
    """Prove the new binary works on this host before we swap it in.

    ``--version`` catches a truncated download, a build that needs a newer glibc
    than this host has, or an import error at startup. ``selftest`` makes real
    TLS round-trips (urllib + aiohttp) to the release server, catching a build
    that can't verify certificates here and so could never reach the server.
    """
    out = _run_new(binary, "--version")
    if expected_version.lstrip("v") not in out:
        raise UpdateError(f"new binary reports {out[-200:]!r}, expected {expected_version}")
    _run_new(binary, "selftest")


def stage_update(version: str, log_fn: LogFn) -> StagedUpdate:
    """Download ``version`` next to the running binary and verify it runs.

    Caller must have checked :func:`self_update_unsupported_reason` first.
    """
    os_arch = _os_arch()
    if os_arch is None:
        raise UpdateError(f"Unsupported platform: {sys.platform}/{platform.machine()}")
    exe = _current_exe()
    # Same directory as the exe, so the final swap is an atomic same-filesystem rename.
    staged = exe.with_name(f".{exe.name}.update")
    url = _download_url(os_arch, version)

    log_fn(f"[update] downloading {version} from {url}")
    try:
        with urllib.request.urlopen(url, timeout=120) as resp, open(staged, "wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            written = 0
            last_pct = -1
            while chunk := resp.read(1 << 16):
                out.write(chunk)
                written += len(chunk)
                if total:
                    pct = written * 100 // total
                    if pct != last_pct and pct % 25 == 0:
                        log_fn(f"[update] {pct}% ({written // 1024} / {total // 1024} KiB)")
                        last_pct = pct
        if total and written != total:
            raise UpdateError(f"short download: {written} of {total} bytes")
        os.chmod(staged, 0o755)
        _smoke_test(staged, version)
    except Exception:
        staged.unlink(missing_ok=True)
        raise
    log_fn(f"[update] {version} downloaded and verified")
    return StagedUpdate(version=version, path=staged, exe=exe)


def install_staged(staged: StagedUpdate, log_fn: LogFn) -> None:
    """Swap the staged binary in, keeping the current one as ``<exe>.prev``.

    Replacing a running binary is safe on Linux: the old inode stays alive
    until the process exits; the next start picks up the new file.
    """
    prev = staged.exe.with_name(staged.exe.name + ".prev")
    prev.unlink(missing_ok=True)
    try:
        os.link(staged.exe, prev)
    except OSError:
        shutil.copy2(staged.exe, prev)
    os.replace(staged.path, staged.exe)
    log_fn(f"[update] installed {staged.version} → {staged.exe} (previous kept as {prev.name})")


def download_update(current_version: str, log_fn: LogFn) -> dict[str, Any]:
    """Manual one-shot: fetch the latest build and install it (no restart)."""
    reason = self_update_unsupported_reason(current_version)
    if reason:
        return {"ok": False, "error": reason}
    info = check_for_update(current_version)
    if "error" in info:
        return {"ok": False, "error": info["error"]}
    if not info["has_update"]:
        return {"ok": True, "version": current_version, "restart_required": False,
                "message": f"Already up to date ({current_version})"}
    try:
        staged = stage_update(info["latest"], log_fn)
        install_staged(staged, log_fn)
    except Exception as exc:  # noqa: BLE001
        log_fn(f"[update] ERROR: {exc}")
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "version": staged.version,
        "restart_required": True,
        "message": f"Updated to {staged.version}. Restart the agent to apply.",
    }


def rollback(log_fn: LogFn) -> dict[str, Any]:
    """Swap ``<exe>.prev`` back in (the current binary becomes the new .prev)."""
    exe = _current_exe()
    prev = exe.with_name(exe.name + ".prev")
    if not prev.exists():
        return {"ok": False, "error": f"No previous binary at {prev}"}
    tmp = exe.with_name(f".{exe.name}.rollback")
    try:
        shutil.copy2(prev, tmp)
        install_staged(StagedUpdate(version="previous", path=tmp, exe=exe), log_fn)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "message": f"Rolled back {exe}. Restart the agent to apply."}
