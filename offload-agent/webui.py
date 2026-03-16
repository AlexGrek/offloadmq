#!/usr/bin/env python3
"""
webui.py — FastAPI web dashboard for offload-agent

Wraps the existing offload-agent.py CLI. Provides a web UI for
configuring capabilities, then runs `register + serve` as a background
subprocess when the user clicks Start.

Usage:
    python webui.py [--host HOST] [--port PORT]
"""

import argparse
import atexit
import logging
import os
import sys
import threading
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Bootstrap: run from offload-agent directory ───────────────────────────────
SCRIPT_DIR = Path(__file__).parent.resolve()
os.chdir(SCRIPT_DIR)
sys.path.insert(0, str(SCRIPT_DIR))

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
import uvicorn

from app.config import load_config, save_config, config_exists

# ── Agent-thread state (module-level, protected by _lock) ─────────────────────
_serve_thread: Optional[threading.Thread] = None
_stop_event: threading.Event = threading.Event()
# Set to True by --agent-autostart / --agent-autostart-enable before uvicorn.run
_autostart: bool = False
_log_buf: deque = deque(maxlen=500)
_log_lock = threading.Lock()
_start_lock = threading.Lock()


def _log(msg: str) -> None:
    with _log_lock:
        _log_buf.append(msg)


class _BufHandler(logging.Handler):
    """Redirect the agent logger into the webui log buffer."""
    def emit(self, record: logging.LogRecord) -> None:
        _log(self.format(record))


# ── System scan cache ──────────────────────────────────────────────────────────
_scan: Dict[str, Any] = {"caps": [], "sysinfo": {}, "scanning": False}
_scan_lock = threading.Lock()


def _run_scan() -> None:
    """Detect available capabilities and collect system info; results cached in _scan."""
    from app.capabilities import detect_capabilities
    from app.systeminfo import collect_system_info

    _log("[scan] Scanning system capabilities…")
    try:
        caps = detect_capabilities(log_fn=_log)
    except Exception as exc:
        caps = []
        _log(f"[scan] Capability detection error: {exc}")

    try:
        info = collect_system_info()
        _log(f"[scan] {info['os']} {info['cpuArch']}, RAM {info['totalMemoryMb']}MB")
        if info.get("gpu"):
            g = info["gpu"]
            _log(f"[scan] GPU: {g.get('vendor')} {g.get('model')} ({g.get('vramMb')}MB VRAM)")
        else:
            _log("[scan] GPU: none detected")
    except Exception as exc:
        info = {}
        _log(f"[scan] sysinfo error: {exc}")

    with _scan_lock:
        _scan["caps"] = caps
        _scan["sysinfo"] = info
        _scan["scanning"] = False
    _log(f"[scan] Done — {len(caps)} capability(s) available: {', '.join(caps) if caps else 'none'}")


def _start_scan() -> None:
    """Start a background scan unless one is already running."""
    with _scan_lock:
        if _scan["scanning"]:
            return
        _scan["scanning"] = True
    threading.Thread(target=_run_scan, daemon=True).start()


# Kick off initial scan at startup
_start_scan()


def _do_start(server: str, api_key: str, caps: List[str]) -> None:
    """Register, authenticate, then run the serve loop in this thread."""
    from app.httphelpers import register_agent, authenticate_agent
    from app.core import serve_tasks

    # Attach webui log capture to the agent logger
    agent_logger = logging.getLogger("agent")
    handler = _BufHandler()
    handler.setFormatter(logging.Formatter("[agent] %(message)s"))
    agent_logger.addHandler(handler)

    try:
        # Step 1: Register -------------------------------------------------------
        _log("[webui] Registering agent…")
        try:
            reg = register_agent(server, sorted(set(caps)), tier=5, capacity=1, api_key=api_key)
        except Exception as exc:
            _log(f"[webui] ERROR: registration failed: {exc}")
            return
        _log(f"[webui] Registered (agentId={reg.get('agentId')})")

        # Step 2: Authenticate ---------------------------------------------------
        _log("[webui] Authenticating…")
        try:
            auth = authenticate_agent(server, reg["agentId"], reg["key"])
        except Exception as exc:
            _log(f"[webui] ERROR: authentication failed: {exc}")
            return
        jwt = auth["token"]
        _log("[webui] Authentication successful")

        # Persist to config
        cfg = load_config()
        cfg.update({
            "server": server,
            "apiKey": api_key,
            "agentId": reg["agentId"],
            "key": reg["key"],
            "jwtToken": jwt,
            "tokenExpiresIn": auth.get("expiresIn"),
        })
        save_config(cfg)

        # Step 3: Serve loop (blocks until stop_event is set) --------------------
        _log("[webui] Starting serve loop…")
        _stop_event.clear()
        serve_tasks(server, jwt, stop_event=_stop_event)
        _log("[webui] Serve loop exited")
    finally:
        agent_logger.removeHandler(handler)


def start_agent() -> str:
    """Kick off registration+serve in a background thread. Returns status string."""
    global _serve_thread
    with _start_lock:
        if _serve_thread is not None and _serve_thread.is_alive():
            return "already_running"

    cfg = load_config()
    server = cfg.get("server", "").strip()
    api_key = cfg.get("apiKey", "").strip()
    # Fall back to all detected caps if the user hasn't made a selection yet
    with _scan_lock:
        detected = list(_scan["caps"])
    caps = cfg.get("capabilities") or detected

    if not server or not api_key:
        _log("[webui] ERROR: save Server URL and API Key before starting")
        return "error: missing config"

    _serve_thread = threading.Thread(target=_do_start, args=(server, api_key, caps), daemon=True)
    _serve_thread.start()
    return "starting"


def stop_agent() -> str:
    """Signal the serve loop to stop and wait for the thread to exit."""
    global _serve_thread
    with _start_lock:
        if _serve_thread is None or not _serve_thread.is_alive():
            _serve_thread = None
            return "not_running"
        _stop_event.set()
        _serve_thread.join(timeout=10)
        _serve_thread = None
        _log("[webui] Agent stopped")
    return "stopped"


def get_status() -> Dict[str, Any]:
    if _serve_thread is None or not _serve_thread.is_alive():
        return {"running": False}
    return {"running": True}


# ── HTML template ──────────────────────────────────────────────────────────────
_CSS = """
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.5 system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem}
h1{font-size:1.4rem;font-weight:700;color:#f1f5f9;margin-bottom:1.5rem}
h2{font-size:.72rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.08em;margin-bottom:.75rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.25rem;max-width:900px}
.card{background:#1e293b;border-radius:8px;padding:1.25rem}
.full{grid-column:1/-1}
lbl{display:block;font-size:.8rem;color:#64748b;margin-bottom:.25rem}
input[type=text]{width:100%;background:#0f172a;border:1px solid #334155;border-radius:4px;
  padding:.45rem .7rem;color:#e2e8f0;font-size:.85rem;margin-bottom:.65rem}
input[type=text]:focus{outline:none;border-color:#6366f1}
.cap{display:flex;align-items:center;gap:.5rem;padding:.3rem 0;font-size:.85rem;cursor:pointer}
.cap input{accent-color:#6366f1;cursor:pointer;width:15px;height:15px}
.row{display:flex;gap:.5rem;margin-top:.75rem;flex-wrap:wrap;align-items:center}
.row input{flex:1;margin:0}
button{padding:.45rem 1.1rem;border-radius:5px;font-size:.85rem;font-weight:500;cursor:pointer;border:none}
.btn-p{background:#6366f1;color:#fff}
.btn-g{background:#22c55e;color:#fff}
.btn-r{background:#ef4444;color:#fff}
.btn-s{padding:.3rem .7rem;font-size:.8rem}
button:hover{opacity:.85}
.btn-ghost{background:transparent;border:1px solid #334155;color:#64748b}
.btn-ghost:hover{border-color:#6366f1;color:#e2e8f0;opacity:1}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:.4rem;vertical-align:middle}
.dot.running{background:#22c55e;box-shadow:0 0 6px #22c55e}
.dot.stopped{background:#475569}
.status-line{font-size:.9rem;margin-bottom:.75rem}
.log{background:#0f172a;border:1px solid #334155;border-radius:4px;
  padding:.7rem;font:12px/1.4 monospace;height:240px;overflow-y:auto;
  white-space:pre-wrap;color:#94a3b8}
hr{border:none;border-top:1px solid #334155;margin:.75rem 0}
.si{font-size:.8rem;color:#94a3b8;line-height:1.8}
.scanning{font-size:.8rem;color:#64748b;font-style:italic}
"""

_JS = """
function poll() {
  fetch('/agent/status').then(r => r.json()).then(d => {
    document.getElementById('dot').className = 'dot ' + (d.running ? 'running' : 'stopped');
    let txt = d.running ? 'Running' : 'Stopped';
    document.getElementById('st').textContent = txt;
  });
  fetch('/agent/logs').then(r => r.json()).then(d => {
    const el = document.getElementById('log');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 5;
    el.textContent = d.lines.join('\\n') || '—';
    if (atBottom) el.scrollTop = el.scrollHeight;
  });
}
poll();
setInterval(poll, 2000);
"""


def _render_sysinfo_html() -> str:
    with _scan_lock:
        scanning = _scan["scanning"]
        info = dict(_scan["sysinfo"])
    if scanning:
        return '<span class="scanning">Scanning…</span>'
    if not info:
        return '<span class="scanning">No scan data yet</span>'
    gpu = info.get("gpu")
    gpu_str = f"{gpu.get('vendor')} {gpu.get('model')} ({gpu.get('vramMb')}MB VRAM)" if gpu else "None"
    return (
        f'<div class="si">{info.get("os")} · {info.get("cpuArch")}</div>'
        f'<div class="si">RAM: {info.get("totalMemoryMb")}MB</div>'
        f'<div class="si">GPU: {gpu_str}</div>'
    )


def _systemd_status() -> Dict[str, Any]:
    """Check whether systemd install is available from this environment."""
    if sys.platform != "linux":
        import platform
        return {"ok": False, "reason": f"Linux only (current OS: {platform.system()})"}
    bin_path = sys.executable if getattr(sys, "frozen", False) else "/usr/local/bin/offload-agent"
    if not os.path.isfile(bin_path):
        return {"ok": False, "reason": f"Binary not found at {bin_path} — run 'install bin' first", "bin_path": bin_path}
    return {"ok": True, "reason": "", "bin_path": bin_path}


# ── Windows startup (Registry) ────────────────────────────────────────────────
_WIN_REG_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_WIN_REG_NAME = "OffloadAgent"


def _win_startup_available() -> bool:
    """Return True if we can manage Windows startup (frozen .exe on Windows)."""
    return sys.platform == "win32" and getattr(sys, "frozen", False)


def _win_startup_enabled() -> bool:
    """Check whether the registry Run entry exists for this app."""
    if not _win_startup_available():
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_REG_KEY, 0, winreg.KEY_READ) as key:
            winreg.QueryValueEx(key, _WIN_REG_NAME)
            return True
    except FileNotFoundError:
        return False
    except OSError:
        return False


def _win_startup_set(enable: bool) -> None:
    """Add or remove the HKCU Run registry entry."""
    if not _win_startup_available():
        return
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_REG_KEY, 0, winreg.KEY_SET_VALUE) as key:
            if enable:
                exe_path = sys.executable
                winreg.SetValueEx(key, _WIN_REG_NAME, 0, winreg.REG_SZ, f'"{exe_path}"')
                _log(f"[startup] Enabled Windows startup: {exe_path}")
            else:
                try:
                    winreg.DeleteValue(key, _WIN_REG_NAME)
                    _log("[startup] Disabled Windows startup")
                except FileNotFoundError:
                    pass
    except OSError as exc:
        _log(f"[startup] ERROR: {exc}")


# ── macOS LaunchAgent (launchd) ───────────────────────────────────────────────
_MAC_LAUNCHD_LABEL = "com.offloadmq.agent"
_MAC_LAUNCHD_PLIST = os.path.expanduser(
    f"~/Library/LaunchAgents/{_MAC_LAUNCHD_LABEL}.plist"
)


def _mac_launchd_available() -> bool:
    """Return True if we can manage macOS LaunchAgent (frozen .app on macOS)."""
    return sys.platform == "darwin" and getattr(sys, "frozen", False)


def _mac_launchd_enabled() -> bool:
    """Check whether the LaunchAgent plist exists."""
    if not _mac_launchd_available():
        return False
    return os.path.isfile(_MAC_LAUNCHD_PLIST)


def _mac_launchd_set(enable: bool) -> None:
    """Install or remove the LaunchAgent plist and load/unload it with launchctl."""
    if not _mac_launchd_available():
        return
    import subprocess
    if enable:
        plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{_MAC_LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{sys.executable}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
"""
        os.makedirs(os.path.dirname(_MAC_LAUNCHD_PLIST), exist_ok=True)
        with open(_MAC_LAUNCHD_PLIST, "w") as f:
            f.write(plist)
        subprocess.run(["launchctl", "load", _MAC_LAUNCHD_PLIST], capture_output=True)
        _log(f"[startup] Enabled macOS LaunchAgent: {_MAC_LAUNCHD_PLIST}")
    else:
        subprocess.run(["launchctl", "unload", _MAC_LAUNCHD_PLIST], capture_output=True)
        try:
            os.remove(_MAC_LAUNCHD_PLIST)
            _log("[startup] Disabled macOS LaunchAgent")
        except FileNotFoundError:
            pass


def _render_page(cfg: Dict, all_caps: List[str], selected: List[str]) -> str:
    st = get_status()
    dot_cls = "running" if st["running"] else "stopped"
    st_text = "Running" if st["running"] else "Stopped"
    autostart_checked = "checked" if cfg.get("autostart") else ""
    cfg_exists = (
        config_exists()
        and bool(cfg.get("server", "").strip())
        and bool(cfg.get("apiKey", "").strip())
    )
    if cfg_exists:
        autostart_html = (
            f'<form method="post" action="/config/autostart">'
            f'<label class="cap">'
            f'<input type="checkbox" name="autostart" value="1" {autostart_checked}'
            f' onchange="this.form.submit()"> Autostart on launch'
            f'</label></form>'
        )
    else:
        autostart_html = (
            '<label class="cap" style="opacity:.5;cursor:not-allowed">'
            '<input type="checkbox" disabled> Autostart on launch'
            '<span style="font-size:.75rem;color:#f59e0b;margin-left:.4rem">— config not found</span>'
            '</label>'
        )

    boxes = "".join(
        f'<label class="cap"><input type="checkbox" name="caps" value="{c}"'
        f'{"  checked" if c in selected else ""}> {c}</label>'
        for c in all_caps
    )

    server_val = cfg.get("server", "")
    api_key_val = cfg.get("apiKey", "")
    sysinfo_html = _render_sysinfo_html()
    sd = _systemd_status()
    if sd["ok"]:
        systemd_html = '<form method="post" action="/install/systemd"><button class="btn-p btn-s" type="submit">Install systemd service</button></form>'
    else:
        systemd_html = f'<button class="btn-p btn-s" disabled style="opacity:.4;cursor:not-allowed">Install systemd service</button><div class="si" style="margin-top:.5rem;color:#64748b">{sd["reason"]}</div>'

    # Windows startup toggle
    win_startup_avail = _win_startup_available()
    win_startup_on = _win_startup_enabled() if win_startup_avail else False
    win_startup_checked = "checked" if win_startup_on else ""

    # macOS LaunchAgent toggle
    mac_startup_avail = _mac_launchd_available()
    mac_startup_on = _mac_launchd_enabled() if mac_startup_avail else False
    mac_startup_checked = "checked" if mac_startup_on else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offload Agent</title>
<style>{_CSS}</style>
</head>
<body>
<h1>Offload Agent</h1>
<div class="grid">

  <!-- Agent status + controls -->
  <div class="card">
    <h2>Agent</h2>
    <div class="status-line">
      <span class="dot {dot_cls}" id="dot"></span><span id="st">{st_text}</span>
    </div>
    <div class="row">
      <form method="post" action="/agent/start">
        <button class="btn-g" type="submit">&#9654; Start</button>
      </form>
      <form method="post" action="/agent/stop">
        <button class="btn-r" type="submit">&#9632; Stop</button>
      </form>
    </div>
    <div class="row" style="margin-top:.75rem">
      {autostart_html}
    </div>
  </div>

  <!-- Connection settings -->
  <div class="card">
    <h2>Connection</h2>
    <form method="post" action="/config">
      <lbl>Server URL</lbl>
      <input type="text" name="server" value="{server_val}" placeholder="http://localhost:3069">
      <lbl>API Key</lbl>
      <input type="text" name="apiKey" value="{api_key_val}" placeholder="ak_live_...">
      <div class="row" style="margin-top:.75rem">
        <button class="btn-p" type="submit">Save</button>
        <a href="/config/reload" class="btn-ghost btn-s" style="text-decoration:none;display:inline-flex;align-items:center">&#8635; Load from disk</a>
      </div>
    </form>
  </div>

  <!-- System info -->
  <div class="card">
    <h2>System</h2>
    {sysinfo_html}
    <div class="row">
      <form method="post" action="/scan">
        <button class="btn-p btn-s" type="submit">Rescan</button>
      </form>
    </div>
  </div>

  <!-- Service / startup -->
  <div class="card">
    <h2>Service</h2>
    {"" if not win_startup_avail else '''
    <div class="si" style="margin-bottom:.6rem">Launch Offload Agent when you log in to Windows.</div>
    <form method="post" action="/config/win-startup">
      <label class="cap">
        <input type="checkbox" name="win_startup" value="1" ''' + win_startup_checked + '''
          onchange="this.form.submit()"> Start with Windows
      </label>
    </form>
    <hr>
    '''}
    {"" if not mac_startup_avail else '''
    <div class="si" style="margin-bottom:.6rem">Launch Offload Agent when you log in to macOS.</div>
    <form method="post" action="/config/mac-startup">
      <label class="cap">
        <input type="checkbox" name="mac_startup" value="1" ''' + mac_startup_checked + '''
          onchange="this.form.submit()"> Start with macOS
      </label>
    </form>
    <hr>
    '''}
    <div class="si" style="margin-bottom:.6rem">Install as a systemd service that autostarts with the system.</div>
    <div class="row">{systemd_html}</div>
  </div>

  <!-- Capabilities -->
  <div class="card">
    <h2>Capabilities</h2>
    <form method="post" action="/capabilities">
      <div id="caps">{boxes}</div>
      <hr>
      <div class="row">
        <input type="text" name="custom_cap" placeholder="Add capability…">
        <button class="btn-p btn-s" type="submit" name="action" value="add">Add</button>
      </div>
      <div class="row" style="margin-top:.5rem">
        <button class="btn-p" type="submit" name="action" value="save">Save selection</button>
      </div>
    </form>
  </div>

  <!-- Log -->
  <div class="card full">
    <h2>Log</h2>
    <div class="log" id="log">—</div>
  </div>

</div>
<script>{_JS}</script>
</body>
</html>"""


# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(title="Offload Agent")


@app.on_event("startup")
async def _on_startup() -> None:
    """Auto-start agent if --agent-autostart flag or config autostart is set."""
    cfg = load_config()
    if _autostart and cfg.get("autostart"):
        _log("[webui] Autostart enabled — starting agent…")
        start_agent()


def _get_all_caps(cfg: Dict) -> tuple[List[str], List[str]]:
    """Return (all_caps_for_display, selected_caps) using the scan cache."""
    custom = list(cfg.get("custom_caps", []))
    with _scan_lock:
        detected = list(_scan["caps"])
    saved = cfg.get("capabilities")
    # Use all detected caps as default when the user hasn't saved a selection
    selected = list(saved) if saved is not None else list(detected)
    all_caps = sorted(set(detected + custom + selected))
    return all_caps, selected


@app.get("/", response_class=HTMLResponse)
async def index():
    cfg = load_config()
    all_caps, selected = _get_all_caps(cfg)
    return _render_page(cfg, all_caps, selected)


@app.post("/config")
async def save_connection(server: str = Form(""), apiKey: str = Form("")):
    cfg = load_config()
    if server.strip():
        cfg["server"] = server.strip()
    if apiKey.strip():
        cfg["apiKey"] = apiKey.strip()
    save_config(cfg)
    return RedirectResponse("/", status_code=303)


@app.post("/capabilities")
async def save_capabilities(
    request: Request,
    action: str = Form("save"),
    custom_cap: str = Form(""),
):
    form = await request.form()
    checked: List[str] = list(form.getlist("caps"))

    cfg = load_config()
    custom: List[str] = list(cfg.get("custom_caps", []))

    if action == "add" and custom_cap.strip():
        cap = custom_cap.strip()
        if cap not in custom:
            custom.append(cap)
        if cap not in checked:
            checked.append(cap)
        cfg["custom_caps"] = custom

    cfg["capabilities"] = sorted(set(checked))
    save_config(cfg)
    return RedirectResponse("/", status_code=303)


@app.get("/config/reload")
async def reload_config():
    """Re-read config from disk and refresh the UI (also re-checks config existence)."""
    return RedirectResponse("/", status_code=303)


@app.post("/config/autostart")
async def save_autostart(request: Request):
    form = await request.form()
    cfg = load_config()
    cfg["autostart"] = bool(form.get("autostart"))
    save_config(cfg)
    return RedirectResponse("/", status_code=303)


@app.post("/config/win-startup")
async def save_win_startup(request: Request):
    form = await request.form()
    enable = bool(form.get("win_startup"))
    _win_startup_set(enable)
    # When enabling startup, also enable autostart so the agent runs automatically
    if enable:
        cfg = load_config()
        cfg["autostart"] = True
        save_config(cfg)
        _log("[startup] Also enabled 'Autostart on launch' so the agent starts automatically")
    return RedirectResponse("/", status_code=303)


@app.post("/config/mac-startup")
async def save_mac_startup(request: Request):
    form = await request.form()
    enable = bool(form.get("mac_startup"))
    _mac_launchd_set(enable)
    if enable:
        cfg = load_config()
        cfg["autostart"] = True
        save_config(cfg)
        _log("[startup] Also enabled 'Autostart on launch' so the agent starts automatically")
    return RedirectResponse("/", status_code=303)


@app.post("/install/systemd")
async def route_install_systemd():
    import subprocess, getpass
    sd = _systemd_status()
    if not sd["ok"]:
        _log(f"[install] ERROR: {sd['reason']}")
        return RedirectResponse("/", status_code=303)

    bin_path = sd["bin_path"]
    service_name = "offload-agent"
    service_path = f"/etc/systemd/system/{service_name}.service"
    unit = f"""\
[Unit]
Description=Offload Agent (Web UI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={getpass.getuser()}
ExecStartPre=/bin/sleep 30
ExecStart={bin_path} webui --host 0.0.0.0 --port 8080 --agent-autostart
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
"""
    try:
        os.makedirs(os.path.dirname(service_path), exist_ok=True)
        with open(service_path, "w") as f:
            f.write(unit)
        _log(f"[install] Wrote {service_path}")
    except PermissionError:
        _log(f"[install] ERROR: permission denied writing {service_path} — re-run webui with sudo")
        return RedirectResponse("/", status_code=303)

    for cmd in [
        ["systemctl", "daemon-reload"],
        ["systemctl", "enable", service_name],
        ["systemctl", "start", service_name],
    ]:
        r = subprocess.run(cmd, capture_output=True, text=True)
        label = " ".join(cmd)
        if r.returncode == 0:
            _log(f"[install] {label}: OK")
        else:
            _log(f"[install] {label}: {r.stderr.strip() or r.stdout.strip()}")

    _log(f"[install] Done. Check: systemctl status {service_name}")
    return RedirectResponse("/", status_code=303)


@app.post("/agent/start")
async def route_start():
    start_agent()
    return RedirectResponse("/", status_code=303)


@app.post("/agent/stop")
async def route_stop():
    stop_agent()
    return RedirectResponse("/", status_code=303)


@app.get("/agent/status")
async def route_status():
    return JSONResponse(get_status())


@app.post("/scan")
async def route_scan():
    _start_scan()
    return RedirectResponse("/", status_code=303)


@app.get("/agent/logs")
async def route_logs():
    with _log_lock:
        lines = list(_log_buf)
    return JSONResponse({"lines": lines})


# ── Entrypoint ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Offload Agent Web UI")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080)")
    args = parser.parse_args()

    atexit.register(stop_agent)

    print(f"Starting Offload Agent Web UI on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)
