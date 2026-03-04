#!/usr/bin/env python3
"""
webui.py — FastAPI web dashboard for offload-client

Wraps the existing offload-client.py CLI. Provides a web UI for
configuring capabilities, then runs `register + serve` as a background
subprocess when the user clicks Start.

Usage:
    python webui.py [--host HOST] [--port PORT]
"""

import argparse
import atexit
import os
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path
from typing import Any, Dict, List, Optional

# ── Bootstrap: run from offload-client directory ───────────────────────────────
SCRIPT_DIR = Path(__file__).parent.resolve()
os.chdir(SCRIPT_DIR)
sys.path.insert(0, str(SCRIPT_DIR))

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
import uvicorn

from app.config import load_config, save_config

# ── Constants ──────────────────────────────────────────────────────────────────
BUILTIN_CAPS: List[str] = ["debug.echo", "shell.bash", "shellcmd.bash", "tts.kokoro"]

# ── Agent-process state (module-level, protected by _lock) ────────────────────
_proc: Optional[subprocess.Popen] = None
_log_buf: deque = deque(maxlen=500)
_log_lock = threading.Lock()
_start_lock = threading.Lock()


def _log(msg: str) -> None:
    with _log_lock:
        _log_buf.append(msg)


def _pipe_reader(stream, tag: str) -> None:
    """Pump subprocess stdout/stderr lines into the log buffer."""
    try:
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip()
            _log(f"[{tag}] {line}")
    except Exception:
        pass


def _do_start(server: str, api_key: str, caps: List[str]) -> None:
    """Run register → serve in a daemon thread."""
    global _proc

    python = sys.executable

    # Step 1: Register with selected capabilities (synchronous so we see output) -
    _log("[webui] Registering agent…")
    reg_cmd = [python, "offload-client.py", "register",
               "--server", server, "--key", api_key]
    for cap in caps:
        reg_cmd += ["--caps", cap]

    try:
        result = subprocess.run(
            reg_cmd,
            cwd=str(SCRIPT_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=30,
        )
        for line in result.stdout.decode("utf-8", errors="replace").splitlines():
            _log(f"[reg] {line}")
        if result.returncode != 0:
            _log(f"[webui] ERROR: registration failed (exit {result.returncode})")
            return
    except subprocess.TimeoutExpired:
        _log("[webui] ERROR: registration timed out")
        return
    except Exception as exc:
        _log(f"[webui] ERROR during registration: {exc}")
        return

    # Step 2: Start serve loop as long-lived background process ----------------
    _log("[webui] Starting serve loop…")
    try:
        _proc = subprocess.Popen(
            [python, "offload-client.py", "serve"],
            cwd=str(SCRIPT_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
        )
        _log(f"[webui] Agent process started (pid={_proc.pid})")
        threading.Thread(target=_pipe_reader, args=(_proc.stdout, "out"), daemon=True).start()
        threading.Thread(target=_pipe_reader, args=(_proc.stderr, "err"), daemon=True).start()
    except Exception as exc:
        _log(f"[webui] ERROR starting serve: {exc}")


def start_agent() -> str:
    """Kick off registration+serve in the background. Returns status string."""
    global _proc
    with _start_lock:
        if _proc is not None and _proc.poll() is None:
            return "already_running"

    cfg = load_config()
    server = cfg.get("server", "").strip()
    api_key = cfg.get("apiKey", "").strip()
    caps = cfg.get("capabilities", BUILTIN_CAPS[:])

    if not server or not api_key:
        _log("[webui] ERROR: save Server URL and API Key before starting")
        return "error: missing config"

    threading.Thread(target=_do_start, args=(server, api_key, caps), daemon=True).start()
    return "starting"


def stop_agent() -> str:
    """Terminate the agent process."""
    global _proc
    with _start_lock:
        if _proc is None or _proc.poll() is not None:
            _proc = None
            return "not_running"
        try:
            _proc.terminate()
            try:
                _proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _proc.kill()
            _log("[webui] Agent stopped")
        except Exception as exc:
            _log(f"[webui] ERROR stopping agent: {exc}")
        finally:
            _proc = None
    return "stopped"


def get_status() -> Dict[str, Any]:
    if _proc is None:
        return {"running": False}
    rc = _proc.poll()
    if rc is None:
        return {"running": True, "pid": _proc.pid}
    return {"running": False, "exit_code": rc}


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
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:.4rem;vertical-align:middle}
.dot.running{background:#22c55e;box-shadow:0 0 6px #22c55e}
.dot.stopped{background:#475569}
.status-line{font-size:.9rem;margin-bottom:.75rem}
.log{background:#0f172a;border:1px solid #334155;border-radius:4px;
  padding:.7rem;font:12px/1.4 monospace;height:240px;overflow-y:auto;
  white-space:pre-wrap;color:#94a3b8}
hr{border:none;border-top:1px solid #334155;margin:.75rem 0}
"""

_JS = """
function poll() {
  fetch('/agent/status').then(r => r.json()).then(d => {
    document.getElementById('dot').className = 'dot ' + (d.running ? 'running' : 'stopped');
    let txt = d.running ? 'Running (pid ' + d.pid + ')' :
              ('exit_code' in d ? 'Stopped (exit ' + d.exit_code + ')' : 'Stopped');
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


def _render_page(cfg: Dict, all_caps: List[str], selected: List[str]) -> str:
    st = get_status()
    dot_cls = "running" if st["running"] else "stopped"
    if st["running"]:
        st_text = f"Running (pid {st.get('pid')})"
    elif "exit_code" in st:
        st_text = f"Stopped (exit {st['exit_code']})"
    else:
        st_text = "Stopped"

    boxes = "".join(
        f'<label class="cap"><input type="checkbox" name="caps" value="{c}"'
        f'{"  checked" if c in selected else ""}> {c}</label>'
        for c in all_caps
    )

    server_val = cfg.get("server", "")
    api_key_val = cfg.get("apiKey", "")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offload Client</title>
<style>{_CSS}</style>
</head>
<body>
<h1>Offload Client</h1>
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
  </div>

  <!-- Connection settings -->
  <div class="card">
    <h2>Connection</h2>
    <form method="post" action="/config">
      <lbl>Server URL</lbl>
      <input type="text" name="server" value="{server_val}" placeholder="http://localhost:3069">
      <lbl>API Key</lbl>
      <input type="text" name="apiKey" value="{api_key_val}" placeholder="ak_live_...">
      <button class="btn-p" type="submit">Save</button>
    </form>
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
app = FastAPI(title="Offload Client")


def _get_all_caps(cfg: Dict) -> tuple[List[str], List[str]]:
    """Return (all_caps_for_display, selected_caps)."""
    selected = list(cfg.get("capabilities", BUILTIN_CAPS[:]))
    custom = list(cfg.get("custom_caps", []))
    try:
        from app.ollama import get_ollama_models
        ollama = get_ollama_models()
    except Exception:
        ollama = []
    all_caps = sorted(set(BUILTIN_CAPS + ollama + custom + selected))
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


@app.get("/agent/logs")
async def route_logs():
    with _log_lock:
        lines = list(_log_buf)
    return JSONResponse({"lines": lines})


# ── Entrypoint ─────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Offload Client Web UI")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080)")
    args = parser.parse_args()

    atexit.register(stop_agent)

    print(f"Starting Offload Client Web UI on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)
