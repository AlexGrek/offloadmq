#!/usr/bin/env python3
"""
webui.py -- FastAPI backend for offload-agent web dashboard.

Serves the React SPA from frontend/dist and JSON/form API routes.
See webui_backup.py for the previous single-file HTML version.

Usage:
    python webui.py [--host HOST] [--port PORT]
"""

import argparse
import asyncio
import atexit
import json as json_module
import logging
import os
import re
import sys
import threading
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

if sys.platform == "win32":
    for _stream in ("stdout", "stderr"):
        _s = getattr(sys, _stream, None)
        if _s is not None and hasattr(_s, "reconfigure"):
            _s.reconfigure(errors="replace")

if getattr(sys, "frozen", False):
    SCRIPT_DIR = Path(sys._MEIPASS)
    sys.path.insert(0, str(SCRIPT_DIR))
else:
    SCRIPT_DIR = Path(__file__).parent.resolve()
    os.chdir(SCRIPT_DIR)
    sys.path.insert(0, str(SCRIPT_DIR))

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

from app.config import load_config, save_config, config_exists
from app.capabilities import compute_registration_caps
from app.exec.slavemode import ALL_SLAVEMODE_CAPS, CONFIG_KEY as SLAVEMODE_CONFIG_KEY
from app.exec.slavemode import strip_slavemode_caps
try:
    from app._version import APP_VERSION
except ModuleNotFoundError:
    APP_VERSION = "dev"

from webui_comfy import (
    STANDARD_TASK_TYPES,
    list_workflows,
    register_comfy_routes,
    workflows_dir,
)

_serve_thread: Optional[threading.Thread] = None
_stop_event: threading.Event = threading.Event()
_autostart: bool = False
_log_buf: deque = deque(maxlen=500)
_log_lock = threading.Lock()
_start_lock = threading.Lock()


def _log(msg: str) -> None:
    with _log_lock:
        _log_buf.append(msg)


class _BufHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        _log(self.format(record))


_scan: Dict[str, Any] = {"caps": [], "sysinfo": {}, "scanning": False}
_scan_lock = threading.Lock()
_scan_done = threading.Event()


def _run_scan() -> None:
    from app.capabilities import detect_capabilities
    from app.systeminfo import collect_system_info

    _log("[scan] Scanning system capabilities...")
    try:
        caps = detect_capabilities(log_fn=_log)
    except Exception as exc:
        caps = []
        _log(f"[scan] Capability detection error: {exc}")

    try:
        info = collect_system_info()
        _log(f"[scan] {info['os']} {info['cpuArch']}, RAM {info['totalMemoryGb']}GB")
        if info.get("gpu"):
            g = info["gpu"]
            _log(f"[scan] GPU: {g.get('vendor')} {g.get('model')} ({g.get('vramGb', 0)}GB VRAM)")
        else:
            _log("[scan] GPU: none detected")
    except Exception as exc:
        info = {}
        _log(f"[scan] sysinfo error: {exc}")

    with _scan_lock:
        _scan["caps"] = caps
        _scan["sysinfo"] = info
        _scan["scanning"] = False
    _scan_done.set()
    _log(f"[scan] Done -- {len(caps)} capability(s) available: {', '.join(caps) if caps else 'none'}")


def _start_scan() -> None:
    with _scan_lock:
        if _scan["scanning"]:
            return
        _scan["scanning"] = True
    threading.Thread(target=_run_scan, daemon=True).start()


_start_scan()


def _do_start(server: str, api_key: str, caps: List[str], display_name: Optional[str] = None) -> None:
    from app.httphelpers import register_agent, authenticate_agent
    from app.core import serve_tasks

    agent_logger = logging.getLogger("agent")
    handler = _BufHandler()
    handler.setFormatter(logging.Formatter("[agent] %(message)s"))
    agent_logger.addHandler(handler)

    try:
        _log("[webui] Registering agent...")
        try:
            reg = register_agent(server, sorted(set(caps)), tier=5, capacity=1, api_key=api_key, display_name=display_name)
        except Exception as exc:
            _log(f"[webui] ERROR: registration failed: {exc}")
            return
        _log(f"[webui] Registered (agentId={reg.get('agentId')})")

        _log("[webui] Authenticating...")
        try:
            auth = authenticate_agent(server, reg["agentId"], reg["key"])
        except Exception as exc:
            _log(f"[webui] ERROR: authentication failed: {exc}")
            return
        jwt = auth["token"]
        _log("[webui] Authentication successful")

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

        _log("[webui] Starting serve loop...")
        _stop_event.clear()
        serve_tasks(server, jwt, stop_event=_stop_event)
        _log("[webui] Serve loop exited")
    finally:
        agent_logger.removeHandler(handler)


def start_agent() -> str:
    global _serve_thread
    with _start_lock:
        if _serve_thread is not None and _serve_thread.is_alive():
            return "already_running"

    cfg = load_config()
    server = cfg.get("server", "").strip()
    api_key = cfg.get("apiKey", "").strip()
    if not _scan_done.wait(timeout=120):
        _log("[webui] WARNING: capability scan timed out after 120s, continuing with whatever was found")
    with _scan_lock:
        detected = list(_scan["caps"])
    caps = compute_registration_caps(cfg, detected, log_fn=_log)

    if not server or not api_key:
        _log("[webui] ERROR: save Server URL and API Key before starting")
        return "error: missing config"

    display_name: Optional[str] = cfg.get("displayName") or None
    _serve_thread = threading.Thread(target=_do_start, args=(server, api_key, caps, display_name), daemon=True)
    _serve_thread.start()
    return "starting"


def stop_agent() -> str:
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


def _systemd_status() -> Dict[str, Any]:
    if sys.platform != "linux":
        import platform
        return {"ok": False, "reason": f"Linux only (current OS: {platform.system()})"}
    bin_path = sys.executable if getattr(sys, "frozen", False) else "/usr/local/bin/offload-agent"
    if not os.path.isfile(bin_path):
        return {"ok": False, "reason": f"Binary not found at {bin_path} -- run 'install bin' first", "bin_path": bin_path}
    return {"ok": True, "reason": "", "bin_path": bin_path}


from app import startup_win as _startup_win


def _win_startup_available() -> bool:
    return _startup_win.available()


def _win_startup_enabled() -> bool:
    return _startup_win.enabled(log=_log)


def _win_startup_set(enable: bool) -> None:
    _startup_win.set_enabled(enable, log=_log)


from app import startup_mac as _startup_mac


def _mac_launchd_available() -> bool:
    return _startup_mac.available()


def _mac_launchd_enabled() -> bool:
    return _startup_mac.enabled()


def _mac_launchd_set(enable: bool) -> None:
    _startup_mac.set_enabled(enable, log=_log)


_CUSTOM_SAFE_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')


def _custom_caps_dir() -> Path:
    from app.custom_caps import _find_custom_caps_dir
    return _find_custom_caps_dir()


def _list_custom_caps() -> List[Dict[str, Any]]:
    from app.custom_caps import discover_custom_caps
    try:
        return [c.to_dict() for c in discover_custom_caps()]
    except Exception as exc:
        _log(f"[custom] Error listing custom caps: {exc}")
        return []


def _dist_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / "frontend" / "dist"
    return SCRIPT_DIR / "frontend" / "dist"


def _wants_json(request: Request) -> bool:
    return "application/json" in (request.headers.get("accept") or "")


def _done(request: Request) -> Union[JSONResponse, RedirectResponse]:
    if _wants_json(request):
        return JSONResponse({"ok": True})
    return RedirectResponse("/", status_code=303)


def _get_all_caps(cfg: Dict) -> tuple[List[str], List[str]]:
    custom = strip_slavemode_caps(list(cfg.get("custom_caps", [])))
    with _scan_lock:
        detected = strip_slavemode_caps(list(_scan["caps"]))
    saved = cfg.get("capabilities")
    if saved is not None:
        selected = strip_slavemode_caps(list(saved))
    else:
        selected = list(detected)
    all_caps = sorted(set(detected + custom + selected))
    return all_caps, selected


def _build_api_state() -> Dict[str, Any]:
    cfg = load_config()
    all_caps, selected = _get_all_caps(cfg)
    raw_saved_caps = cfg.get("capabilities")
    if raw_saved_caps is not None:
        capabilities_for_ui = strip_slavemode_caps(list(raw_saved_caps))
    else:
        capabilities_for_ui = None
    with _scan_lock:
        scanning = _scan["scanning"]
        sysinfo = dict(_scan["sysinfo"])
    sd = _systemd_status()
    win_a = _win_startup_available()
    mac_a = _mac_launchd_available()
    ce = (
        config_exists()
        and bool(cfg.get("server", "").strip())
        and bool(cfg.get("apiKey", "").strip())
    )
    return {
        "server": cfg.get("server", ""),
        "apiKey": cfg.get("apiKey", ""),
        "displayName": cfg.get("displayName", ""),
        "autostart": bool(cfg.get("autostart")),
        "capabilities": capabilities_for_ui,
        "custom_caps": cfg.get("custom_caps", []),
        "all_caps": all_caps,
        "selected_caps": selected,
        "cfg_exists": ce,
        "comfyui_url": cfg.get("comfyui_url", ""),
        "webuiPort": cfg.get("webuiPort", 8080),
        "scanning": scanning,
        "sysinfo": sysinfo,
        "systemd": sd,
        "win_startup_available": win_a,
        "win_startup_enabled": _win_startup_enabled() if win_a else False,
        "win_startup_value": _startup_win.read_value() if win_a else None,
        "win_startup_exe": sys.executable if win_a else None,
        "win_startup_frozen": getattr(sys, "frozen", False) if win_a else False,
        "mac_startup_available": mac_a,
        "mac_startup_enabled": _mac_launchd_enabled() if mac_a else False,
        "mac_startup_plist": _startup_mac.read_plist() if mac_a else None,
        "mac_startup_exe": sys.executable if mac_a else None,
        "mac_startup_frozen": getattr(sys, "frozen", False) if mac_a else False,
        "mac_startup_log_dir": _startup_mac._LOG_DIR if mac_a else None,
        "workflows": list_workflows(),
        "workflows_dir": str(workflows_dir()),
        "task_types": list(STANDARD_TASK_TYPES),
        "custom_caps": _list_custom_caps(),
        "custom_caps_dir": str(_custom_caps_dir()),
        "running": get_status().get("running", False),
        "version": APP_VERSION,
        "slavemode_all_caps": ALL_SLAVEMODE_CAPS,
        "slavemode_allowed": list(cfg.get(SLAVEMODE_CONFIG_KEY) or []),
    }


app = FastAPI(
    title="Offload Agent",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

register_comfy_routes(app, log=_log, start_scan=_start_scan, done=_done)


@app.on_event("startup")
async def _on_startup() -> None:
    cfg = load_config()
    if _autostart and cfg.get("autostart"):
        _log("[webui] Autostart enabled -- starting agent...")
        start_agent()


@app.get("/api/state")
async def api_state():
    return JSONResponse(_build_api_state())


@app.post("/config")
async def save_connection(request: Request, server: str = Form(""), apiKey: str = Form(""), displayName: str = Form("")):
    cfg = load_config()
    if server.strip():
        cfg["server"] = server.strip()
    if apiKey.strip():
        cfg["apiKey"] = apiKey.strip()
    cfg["displayName"] = displayName.strip()[:50]
    save_config(cfg)
    return _done(request)


@app.post("/config/webui-port")
async def save_webui_port(request: Request, port: str = Form("")):
    port_str = port.strip()
    if port_str:
        try:
            port_int = int(port_str)
            if not (1 <= port_int <= 65535):
                raise ValueError("out of range")
        except ValueError:
            return JSONResponse({"ok": False, "error": "invalid port"}, status_code=400)
        cfg = load_config()
        cfg["webuiPort"] = port_int
        save_config(cfg)
        _log(f"[webui] Web UI port set to {port_int} — restart to apply")
    return _done(request)


@app.get("/config/raw")
async def get_raw_config():
    cfg = load_config()
    return JSONResponse({"json": json_module.dumps(cfg, indent=2)})


@app.post("/config/raw")
async def save_raw_config(request: Request):
    body = await request.body()
    try:
        new_cfg = json_module.loads(body)
        if not isinstance(new_cfg, dict):
            raise ValueError("config must be a JSON object")
    except (json_module.JSONDecodeError, ValueError) as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
    save_config(new_cfg)
    _log("[webui] Config saved via raw JSON editor")
    return JSONResponse({"ok": True})


@app.post("/capabilities")
async def save_capabilities(
    request: Request,
    action: str = Form("save"),
    custom_cap: str = Form(""),
):
    form = await request.form()
    checked: List[str] = [
        str(c) for c in form.getlist("caps") if not str(c).startswith("slavemode.")
    ]

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
    return _done(request)


@app.get("/config/reload")
async def reload_config():
    return RedirectResponse("/", status_code=303)


@app.post("/config/autostart")
async def save_autostart(request: Request):
    form = await request.form()
    cfg = load_config()
    cfg["autostart"] = bool(form.get("autostart"))
    save_config(cfg)
    return _done(request)


@app.get("/api/win-startup/debug")
async def win_startup_debug() -> JSONResponse:
    return JSONResponse({
        "available": _startup_win.available(),
        "frozen": getattr(sys, "frozen", False),
        "exe": sys.executable,
        "registry_value": _startup_win.read_value(),
    })


@app.post("/config/win-startup")
async def save_win_startup(request: Request):
    cfg = load_config()
    if not cfg.get("server", "").strip() or not cfg.get("apiKey", "").strip():
        _log("[startup] ERROR: configure server & API key before enabling startup")
        return _done(request)
    form = await request.form()
    enable = bool(form.get("win_startup"))
    _win_startup_set(enable)
    if enable:
        cfg = load_config()
        cfg["autostart"] = True
        save_config(cfg)
        _log("[startup] Also enabled 'Autostart on launch' so the agent starts automatically")
    return _done(request)


@app.post("/config/mac-startup")
async def save_mac_startup(request: Request):
    cfg = load_config()
    if not cfg.get("server", "").strip() or not cfg.get("apiKey", "").strip():
        _log("[startup] ERROR: configure server & API key before enabling startup")
        return _done(request)
    form = await request.form()
    enable = bool(form.get("mac_startup"))
    _mac_launchd_set(enable)
    if enable:
        cfg = load_config()
        cfg["autostart"] = True
        save_config(cfg)
        _log("[startup] Also enabled 'Autostart on launch' so the agent starts automatically")
    return _done(request)


@app.post("/install/systemd")
async def route_install_systemd(request: Request):
    import subprocess
    import getpass
    sd = _systemd_status()
    if not sd["ok"]:
        _log(f"[install] ERROR: {sd['reason']}")
        return _done(request)

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
ExecStart={bin_path} webui --host 0.0.0.0 --agent-autostart
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
        _log(f"[install] ERROR: permission denied writing {service_path} -- re-run webui with sudo")
        return _done(request)

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
    return _done(request)


@app.post("/agent/start")
async def route_start(request: Request):
    start_agent()
    return _done(request)


@app.post("/agent/stop")
async def route_stop(request: Request):
    stop_agent()
    return _done(request)


@app.get("/agent/status")
async def route_status():
    return JSONResponse(get_status())


@app.post("/scan")
async def route_scan(request: Request):
    _start_scan()
    return _done(request)


def _push_capabilities_to_server_async() -> None:
    """If the agent loop is running, push merged caps so slavemode changes take effect."""

    def _run() -> None:
        cfg = load_config()
        if not get_status().get("running"):
            return
        jwt = str(cfg.get("jwtToken", "") or "").strip()
        server = str(cfg.get("server", "") or "").strip()
        if not jwt or not server:
            return
        try:
            from app.httphelpers import HttpClient, update_agent_capabilities
            from app.systeminfo import calculate_tier, collect_system_info

            with _scan_lock:
                detected = list(_scan["caps"])
            caps = compute_registration_caps(cfg, detected, log_fn=_log)
            http = HttpClient(server, jwt)
            tier: int = cfg.get("tier") or calculate_tier(collect_system_info())
            capacity: int = int(cfg.get("capacity", 1))
            display_name: Optional[str] = cfg.get("displayName") or None
            update_agent_capabilities(http, caps, tier, capacity, display_name)
            _log("[slavemode] Pushed updated capabilities to server")
        except Exception as exc:
            _log(f"[slavemode] Could not push capabilities: {exc}")

    threading.Thread(target=_run, daemon=True).start()


@app.post("/slavemode-caps")
async def route_slavemode_caps(request: Request):
    form = await request.form()
    submitted: List[str] = list(form.getlist("caps"))
    allowed = [c for c in submitted if c in ALL_SLAVEMODE_CAPS]
    cfg = load_config()
    cfg[SLAVEMODE_CONFIG_KEY] = sorted(set(allowed))
    save_config(cfg)
    _push_capabilities_to_server_async()
    return _done(request)


@app.get("/agent/logs")
async def route_logs(n: int = 100):
    with _log_lock:
        lines = list(_log_buf)
    return JSONResponse({"lines": lines[-n:] if n > 0 else lines})


@app.get("/api/update/check")
async def route_update_check():
    from app.updater import check_for_update
    result = await asyncio.to_thread(check_for_update, APP_VERSION)
    return JSONResponse(result)


@app.post("/api/update/download")
async def route_update_download():
    from app.updater import download_update
    result = await asyncio.to_thread(download_update, _log)
    return JSONResponse(result)


@app.get("/custom/list")
async def route_list_custom_caps():
    return JSONResponse({"custom_caps": _list_custom_caps(), "custom_caps_dir": str(_custom_caps_dir())})


@app.get("/custom/get/{cap_name}")
async def route_get_custom_cap(cap_name: str):
    from app.custom_caps import _find_custom_caps_dir, load_custom_cap

    if not _CUSTOM_SAFE_RE.match(cap_name):
        return JSONResponse({"error": "Invalid custom cap name"}, status_code=400)

    caps_dir = _find_custom_caps_dir()
    for suffix in (".yaml", ".yml"):
        path = caps_dir / f"{cap_name}{suffix}"
        if path.is_file():
            try:
                cap = load_custom_cap(path)
                return JSONResponse({
                    "cap": cap.to_dict(),
                    "raw": path.read_text(encoding="utf-8"),
                })
            except Exception as exc:
                return JSONResponse({"error": str(exc)}, status_code=400)

    return JSONResponse({"error": f"Custom cap '{cap_name}' not found"}, status_code=404)


@app.post("/custom/save")
async def route_save_custom_cap(request: Request):
    """Save a custom cap from JSON body or raw YAML."""
    import yaml
    from app.custom_caps import _find_custom_caps_dir, validate_custom_cap_yaml, _SAFE_NAME_RE

    content_type = request.headers.get("content-type", "")

    if "application/json" in content_type:
        data = await request.json()
        raw_yaml = data.get("yaml")
        if not raw_yaml:
            # Build YAML from structured data
            cap_dict = {
                "name": data.get("name", ""),
                "description": data.get("description", ""),
                "script": data.get("script", ""),
            }
            if data.get("params"):
                cap_dict["params"] = data["params"]
            if data.get("timeout"):
                cap_dict["timeout"] = int(data["timeout"])
            if data.get("env"):
                cap_dict["env"] = data["env"]
            raw_yaml = yaml.dump(cap_dict, default_flow_style=False, sort_keys=False)
    else:
        form = await request.form()
        raw_yaml = form.get("yaml", "")

    if not raw_yaml:
        _log("[custom] ERROR: no YAML content provided")
        return JSONResponse({"error": "No YAML content provided"}, status_code=400)

    try:
        cap = validate_custom_cap_yaml(raw_yaml)
    except Exception as exc:
        _log(f"[custom] ERROR: validation failed: {exc}")
        return JSONResponse({"error": str(exc)}, status_code=400)

    caps_dir = _find_custom_caps_dir()
    caps_dir.mkdir(parents=True, exist_ok=True)
    path = caps_dir / f"{cap.name}.yaml"

    # Prevent path traversal
    if not str(path.resolve()).startswith(str(caps_dir.resolve())):
        return JSONResponse({"error": "Path traversal detected"}, status_code=400)

    path.write_text(raw_yaml, encoding="utf-8")
    _log(f"[custom] Saved custom cap '{cap.name}' to {path}")
    _start_scan()
    return JSONResponse({"ok": True, "cap": cap.to_dict()})


@app.post("/custom/upload")
async def route_upload_custom_cap(
    request: Request,
    cap_file: UploadFile = File(None),
):
    """Upload a custom capability YAML file."""
    from app.custom_caps import _find_custom_caps_dir, validate_custom_cap_yaml

    if not cap_file or not cap_file.filename:
        _log("[custom] ERROR: no file uploaded")
        return _done(request)

    raw = await cap_file.read()
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        _log("[custom] ERROR: uploaded file is not valid UTF-8")
        return _done(request)

    try:
        cap = validate_custom_cap_yaml(content)
    except Exception as exc:
        _log(f"[custom] ERROR: validation failed: {exc}")
        return _done(request)

    caps_dir = _find_custom_caps_dir()
    caps_dir.mkdir(parents=True, exist_ok=True)
    path = caps_dir / f"{cap.name}.yaml"

    if not str(path.resolve()).startswith(str(caps_dir.resolve())):
        _log("[custom] ERROR: path traversal detected")
        return _done(request)

    path.write_text(content, encoding="utf-8")
    _log(f"[custom] Uploaded custom cap '{cap.name}' to {path}")
    _start_scan()
    return _done(request)


@app.post("/custom/delete")
async def route_delete_custom_cap(request: Request):
    from app.custom_caps import delete_custom_cap

    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        data = await request.json()
        name = data.get("name", "")
    else:
        form = await request.form()
        name = form.get("name", "")

    name = str(name).strip()
    if not name or not _CUSTOM_SAFE_RE.match(name):
        _log("[custom] ERROR: invalid custom cap name in delete request")
        return _done(request)

    if delete_custom_cap(name):
        _log(f"[custom] Deleted custom cap '{name}'")
        _start_scan()
    else:
        _log(f"[custom] Custom cap '{name}' not found -- nothing deleted")

    return _done(request)


_DIST = _dist_dir()
_MISSING_UI = (
    "<html><body style='font-family:sans-serif;padding:2rem;background:#0f172a;color:#e2e8f0'>"
    "<h1>Offload Agent</h1>"
    "<p>Web UI assets missing. Build the frontend:</p>"
    "<pre style='background:#1e293b;padding:1rem'>cd frontend && npm install && npm run build</pre>"
    "<p>API is still available at <code>/api/state</code></p>"
    "</body></html>"
)

if _DIST.is_dir() and (_DIST / "index.html").is_file():
    _assets = _DIST / "assets"
    if _assets.is_dir():
        app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")

    @app.get("/")
    async def serve_spa_root():
        return FileResponse(_DIST / "index.html")

    @app.get("/{full_path:path}")
    async def serve_spa_fallback(full_path: str):
        base = _DIST.resolve()
        candidate = (_DIST / full_path).resolve()
        try:
            candidate.relative_to(base)
        except ValueError:
            return FileResponse(_DIST / "index.html")
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_DIST / "index.html")
else:

    @app.get("/")
    async def serve_spa_missing():
        return HTMLResponse(_MISSING_UI, status_code=503)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Offload Agent Web UI")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080)")
    args = parser.parse_args()

    atexit.register(stop_agent)

    print(f"Starting Offload Agent Web UI on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)