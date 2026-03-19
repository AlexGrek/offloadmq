#!/usr/bin/env python3
"""
webui.py -- FastAPI backend for offload-agent web dashboard.

Serves the React SPA from frontend/dist and JSON/form API routes.
See webui_backup.py for the previous single-file HTML version.

Usage:
    python webui.py [--host HOST] [--port PORT]
"""

import argparse
import atexit
import json
import logging
import os
import re
import shutil
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
    _scan_done.set()
    _log(f"[scan] Done -- {len(caps)} capability(s) available: {', '.join(caps) if caps else 'none'}")


def _start_scan() -> None:
    with _scan_lock:
        if _scan["scanning"]:
            return
        _scan["scanning"] = True
    threading.Thread(target=_run_scan, daemon=True).start()


_start_scan()


def _do_start(server: str, api_key: str, caps: List[str]) -> None:
    from app.httphelpers import register_agent, authenticate_agent
    from app.core import serve_tasks

    agent_logger = logging.getLogger("agent")
    handler = _BufHandler()
    handler.setFormatter(logging.Formatter("[agent] %(message)s"))
    agent_logger.addHandler(handler)

    try:
        _log("[webui] Registering agent...")
        try:
            reg = register_agent(server, sorted(set(caps)), tier=5, capacity=1, api_key=api_key)
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
    caps = cfg.get("capabilities") or detected

    if not server or not api_key:
        _log("[webui] ERROR: save Server URL and API Key before starting")
        return "error: missing config"

    _serve_thread = threading.Thread(target=_do_start, args=(server, api_key, caps), daemon=True)
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


_WIN_REG_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_WIN_REG_NAME = "OffloadAgent"


def _win_startup_available() -> bool:
    return sys.platform == "win32" and getattr(sys, "frozen", False)


def _win_startup_enabled() -> bool:
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
    if not _win_startup_available():
        return
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_REG_KEY, 0, winreg.KEY_SET_VALUE) as key:
            if enable:
                exe_path = sys.executable
                delayed_cmd = f'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 60; & \'{exe_path}\'"'
                winreg.SetValueEx(key, _WIN_REG_NAME, 0, winreg.REG_SZ, delayed_cmd)
                _log(f"[startup] Enabled Windows startup with 60s delay: {exe_path}")
            else:
                try:
                    winreg.DeleteValue(key, _WIN_REG_NAME)
                    _log("[startup] Disabled Windows startup")
                except FileNotFoundError:
                    pass
    except OSError as exc:
        _log(f"[startup] ERROR: {exc}")


_MAC_LAUNCHD_LABEL = "com.offloadmq.agent"
_MAC_LAUNCHD_PLIST = os.path.expanduser(
    f"~/Library/LaunchAgents/{_MAC_LAUNCHD_LABEL}.plist"
)


def _mac_launchd_available() -> bool:
    return sys.platform == "darwin" and getattr(sys, "frozen", False)


def _mac_launchd_enabled() -> bool:
    if not _mac_launchd_available():
        return False
    return os.path.isfile(_MAC_LAUNCHD_PLIST)


def _mac_launchd_set(enable: bool) -> None:
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


_WF_SAFE_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')

_STANDARD_TASK_TYPES = [
    "txt2img", "img2img", "inpaint", "outpaint",
    "upscale", "face_swap", "txt2video", "img2video",
]


def _workflows_dir() -> Path:
    from app.exec.imggen.workflow import _find_workflows_dir
    return _find_workflows_dir()


def _list_workflows() -> List[Dict[str, Any]]:
    wdir = _workflows_dir()
    if not wdir.is_dir():
        return []
    result = []
    for entry in sorted(wdir.iterdir()):
        if not entry.is_dir() or not _WF_SAFE_RE.match(entry.name):
            continue
        task_types = sorted(
            p.stem for p in entry.glob("*.json")
            if not p.name.endswith(".params.json") and _WF_SAFE_RE.match(p.stem)
        )
        result.append({"name": entry.name, "task_types": task_types})
    return result


def _default_params(task_type: str) -> Dict[str, Any]:
    params: Dict[str, Any] = {
        "prompt": [["6", "text"]],
        "negative": [["7", "text"]],
        "width": [["5", "width"]],
        "height": [["5", "height"]],
        "seed": [["3", "seed"]],
    }
    if task_type in ("img2img", "inpaint", "outpaint", "face_swap", "upscale"):
        params["input_image"] = [["10", "image"]]
    if task_type == "face_swap":
        params["face_swap"] = [["11", "image"]]
    if task_type == "upscale":
        params["upscale"] = [["14", "upscale_factor"]]
    if task_type in ("txt2video", "img2video"):
        params["length"] = [["8", "frame_count"]]
        if task_type == "img2video":
            params["input_image"] = [["10", "image"]]
    return params


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
    custom = list(cfg.get("custom_caps", []))
    with _scan_lock:
        detected = list(_scan["caps"])
    saved = cfg.get("capabilities")
    selected = list(saved) if saved is not None else list(detected)
    all_caps = sorted(set(detected + custom + selected))
    return all_caps, selected


def _build_api_state() -> Dict[str, Any]:
    cfg = load_config()
    all_caps, selected = _get_all_caps(cfg)
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
        "autostart": bool(cfg.get("autostart")),
        "capabilities": cfg.get("capabilities"),
        "custom_caps": cfg.get("custom_caps", []),
        "all_caps": all_caps,
        "selected_caps": selected,
        "cfg_exists": ce,
        "comfyui_url": cfg.get("comfyui_url", ""),
        "scanning": scanning,
        "sysinfo": sysinfo,
        "systemd": sd,
        "win_startup_available": win_a,
        "win_startup_enabled": _win_startup_enabled() if win_a else False,
        "mac_startup_available": mac_a,
        "mac_startup_enabled": _mac_launchd_enabled() if mac_a else False,
        "workflows": _list_workflows(),
        "workflows_dir": str(_workflows_dir()),
        "task_types": list(_STANDARD_TASK_TYPES),
        "running": get_status().get("running", False),
    }


app = FastAPI(
    title="Offload Agent",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


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
async def save_connection(request: Request, server: str = Form(""), apiKey: str = Form("")):
    cfg = load_config()
    if server.strip():
        cfg["server"] = server.strip()
    if apiKey.strip():
        cfg["apiKey"] = apiKey.strip()
    save_config(cfg)
    return _done(request)


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


@app.get("/agent/logs")
async def route_logs():
    with _log_lock:
        lines = list(_log_buf)
    return JSONResponse({"lines": lines})


@app.post("/config/comfyui-url")
async def save_comfyui_url(request: Request, comfyui_url: str = Form("")):
    cfg = load_config()
    cfg["comfyui_url"] = comfyui_url.strip()
    save_config(cfg)
    _log(f"[imggen] ComfyUI URL saved: {comfyui_url.strip() or '(cleared)'}")
    return _done(request)


@app.post("/workflows/add")
async def route_add_workflow(
    request: Request,
    workflow_name: str = Form(""),
    task_type: str = Form(""),
    workflow_file: UploadFile = File(None),
):
    workflow_name = workflow_name.strip()
    task_type = task_type.strip()

    if not workflow_name or not _WF_SAFE_RE.match(workflow_name):
        _log("[imggen] ERROR: invalid workflow name -- use only letters, digits, hyphens, dots")
        return _done(request)
    if not task_type or not _WF_SAFE_RE.match(task_type):
        _log(f"[imggen] ERROR: invalid task type '{task_type}'")
        return _done(request)

    wf_dir = (_workflows_dir() / workflow_name).resolve()
    if not str(wf_dir).startswith(str(_workflows_dir().resolve())):
        _log("[imggen] ERROR: path traversal detected in workflow name")
        return _done(request)

    wf_dir.mkdir(parents=True, exist_ok=True)

    json_path = wf_dir / f"{task_type}.json"
    if workflow_file and workflow_file.filename:
        raw = await workflow_file.read()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            _log(f"[imggen] ERROR: uploaded file is not valid JSON -- {exc}")
            return _done(request)
        with open(json_path, "w") as f:
            json.dump(parsed, f, indent=2)
        _log(f"[imggen] Saved workflow JSON: {json_path}")
    else:
        if not json_path.exists():
            with open(json_path, "w") as f:
                json.dump({}, f)
            _log(f"[imggen] Created empty workflow placeholder: {json_path} -- replace with ComfyUI API-format export")

    params_path = wf_dir / f"{task_type}.params.json"
    if not params_path.exists():
        with open(params_path, "w") as f:
            json.dump(_default_params(task_type), f, indent=2)
        _log(f"[imggen] Generated starter params mapping: {params_path}")

    _log(f"[imggen] Workflow '{workflow_name}/{task_type}' added -- rescan to register capability")
    _start_scan()
    return _done(request)


@app.post("/workflows/delete")
async def route_delete_workflow(request: Request, workflow_name: str = Form("")):
    workflow_name = workflow_name.strip()

    if not workflow_name or not _WF_SAFE_RE.match(workflow_name):
        _log("[imggen] ERROR: invalid workflow name in delete request")
        return _done(request)

    wf_dir = (_workflows_dir() / workflow_name).resolve()
    if not str(wf_dir).startswith(str(_workflows_dir().resolve())):
        _log("[imggen] ERROR: path traversal detected in delete request")
        return _done(request)

    if wf_dir.is_dir():
        shutil.rmtree(wf_dir)
        _log(f"[imggen] Deleted workflow '{workflow_name}'")
        _start_scan()
    else:
        _log(f"[imggen] Workflow '{workflow_name}' not found -- nothing deleted")

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
