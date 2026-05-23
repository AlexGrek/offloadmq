"""Linux systemd unit installation for omq webui."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


_UNIT_NAME = "offloadmq-agent.service"


def _unit_path() -> Path:
    return Path.home() / ".config" / "systemd" / "user" / _UNIT_NAME


def is_installed() -> bool:
    return _unit_path().exists()


def uninstall_systemd_unit() -> dict[str, Any]:
    if sys.platform != "linux":
        return {"ok": False, "message": "systemd uninstall is only supported on Linux"}
    path = _unit_path()
    subprocess.run(["systemctl", "--user", "stop", _UNIT_NAME], check=False)
    subprocess.run(["systemctl", "--user", "disable", _UNIT_NAME], check=False)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    return {"ok": True, "message": f"Removed {path}"}


def install_systemd_unit(*, host: str = "0.0.0.0", port: int = 8090) -> dict[str, Any]:
    if sys.platform != "linux":
        return {"ok": False, "message": "systemd install is only supported on Linux"}

    omq = shutil.which("omq") or shutil.which("uv")
    if not omq:
        return {"ok": False, "message": "Could not find omq or uv in PATH"}

    cwd = Path.cwd()
    unit_path = _unit_path()
    unit_path.parent.mkdir(parents=True, exist_ok=True)

    if omq.endswith("uv"):
        exec_start = f"{omq} run omq webui --host {host} --port {port} --start"
    else:
        exec_start = f"{omq} webui --host {host} --port {port} --start"

    content = f"""[Unit]
Description=OffloadMQ Agent v2
After=network.target

[Service]
Type=simple
WorkingDirectory={cwd}
ExecStart={exec_start}
Restart=on-failure
Environment=PATH={os.environ.get('PATH', '')}

[Install]
WantedBy=default.target
"""
    unit_path.write_text(content)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=False)
    subprocess.run(["systemctl", "--user", "enable", _UNIT_NAME], check=False)
    return {"ok": True, "message": f"Installed {unit_path}", "unit": str(unit_path)}
