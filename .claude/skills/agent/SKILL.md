---
name: agent
description: Senior Python engineer context for the offload-agent subsystem. Use when working on offload-agent — webui, config, capabilities, executors, core polling loop, or cross-platform packaging.
---

# Offload Agent — Senior Python Engineering

## Architecture Overview

The offload-agent is a **standalone Python daemon** that polls a remote OffloadMQ server for tasks and executes them locally. It exposes a **FastAPI web dashboard** for configuration and control.

### Entry Points

| File | Purpose |
|---|---|
| `offload-agent.py` | CLI dispatcher — routes to `webui`, `cli`, `install` subcommands |
| `offload-agent-mac.py` | macOS `.app` entry — runs webui in daemon thread + pystray tray icon on main thread |
| `offload-agent-win.pyw` | Windows `.exe` wrapper (no console window) |
| `webui.py` | FastAPI dashboard — config UI, agent control, live logs |

`SCRIPT_DIR = Path(__file__).parent.resolve(); os.chdir(SCRIPT_DIR)` is set at startup — all relative paths (config file, venv) are anchored to the agent directory.

### App Package Layout (`app/`)

```
app/
  config.py          # JSON config load/save/existence check
  core.py            # serve_tasks() — main polling + dispatch loop (blocking)
  capabilities.py    # detect_capabilities() — runtime probe of available caps
  systeminfo.py      # collect_system_info() — OS/CPU/RAM/GPU
  httphelpers.py     # register_agent(), authenticate_agent(), HTTP client
  models.py          # Pydantic models: TaskId, TaskResultReport, etc.
  cli.py             # Typer CLI commands
  ollama.py          # Ollama integration helpers
  url_utils.py       # URL builder utilities
  websocket_client.py
  exec/
    llm.py           # Ollama LLM executor (streaming, images)
    shell.py         # Bash subprocess executor
    shellcmd.py      # Shell command executor
    tts.py           # Kokoro TTS executor
    debug.py         # Echo debug executor
    helpers.py       # Shared executor utilities
  data/
    fs_utils.py      # Filesystem helpers
    updn.py          # File upload/download
```

### Config File

**Location:** `.offload-agent.json` in `SCRIPT_DIR` (next to the entry point).

```python
CONFIG_FILE = ".offload-agent.json"

def config_exists() -> bool:
    return Path(CONFIG_FILE).exists()

def load_config() -> Dict[str, Any]:   # returns {} if missing or malformed
def save_config(cfg: Dict[str, Any]) -> None:
```

**Schema:**
```json
{
  "server": "http://...",
  "apiKey": "ak_live_...",
  "agentId": "...",
  "key": "...",
  "jwtToken": "...",
  "tokenExpiresIn": 1234567890,
  "autostart": true,
  "capabilities": ["llm.mistral", "shell.bash"],
  "custom_caps": ["my.custom"]
}
```

A config is **considered unconfigured** (treated same as missing) if `server` or `apiKey` are absent or blank — even if the file exists.

### WebUI (FastAPI)

`webui.py` is a **single-file FastAPI app** — HTML, CSS, and JS are embedded as string constants (`_CSS`, `_JS`). No template engine, no static files.

**Module-level shared state** (protected by locks):
```python
_serve_thread: Optional[threading.Thread]   # the running agent thread
_stop_event: threading.Event                # signals serve loop to exit
_log_buf: deque(maxlen=500)                 # circular log buffer
_scan: Dict[str, Any]                       # capability scan cache
```

**Thread model:**
- FastAPI/uvicorn runs on the main thread (or a webui daemon thread on macOS)
- Agent (`serve_tasks`) runs in a daemon background thread
- Capability scan runs in a separate daemon thread
- All shared state uses explicit `threading.Lock()` — never `asyncio` locks in non-async code

**Routes follow a consistent pattern:**
```python
@app.post("/config")
async def save_connection(server: str = Form(""), apiKey: str = Form("")):
    cfg = load_config()
    # mutate cfg
    save_config(cfg)
    return RedirectResponse("/", status_code=303)  # PRG pattern
```

Page renders (`GET /`) always call `load_config()` and `config_exists()` fresh — no server-side session state.

### Agent Lifecycle

```
register_agent(server, caps, tier, capacity, api_key)
  → {"agentId": ..., "key": ...}

authenticate_agent(server, agentId, key)
  → {"token": jwt, "expiresIn": ...}

serve_tasks(server, jwt, stop_event)   # blocks until stop_event.set()
  → polls /private/agent/task/poll
  → dispatches to executor by capability prefix
  → reports progress/completion via HTTP
```

### Capability System

Capabilities are dot-namespaced strings: `llm.mistral`, `shell.bash`, `tts.kokoro`, `debug.echo`.

`detect_capabilities(log_fn)` runs synchronous probes (Ollama HTTP ping, bash which, etc.) and returns a list of available capability strings. It's called in a daemon thread at startup and on-demand via `POST /scan`.

Executors in `app/exec/` are selected by capability prefix. Adding a new executor = add a file, register it in `core.py`'s dispatch table.

### Cross-Platform Notes

| Platform | Autostart mechanism | Available check |
|---|---|---|
| Linux | systemd service file | `sys.platform == "linux"` + binary at `/usr/local/bin/offload-agent` |
| macOS | LaunchAgent plist in `~/Library/LaunchAgents/` | `sys.platform == "darwin" and getattr(sys, "frozen", False)` |
| Windows | HKCU registry Run key | `sys.platform == "win32" and getattr(sys, "frozen", False)` |

`getattr(sys, "frozen", False)` is True only in PyInstaller-built binaries — guards platform features that only work in packaged form.

---

## Python Conventions for This Codebase

### Style

- Python 3.10+ — use `X | Y` union syntax, `match`, structural pattern matching where it fits
- Type hints on all function signatures; `Dict`, `List`, `Optional` from `typing` (existing code uses these — match the file's existing import style when editing, prefer built-ins `dict`, `list` in new files)
- `pathlib.Path` for all filesystem operations — never raw string concatenation for paths
- `f-strings` everywhere; no `%` formatting or `.format()`

### Config

- Always `load_config()` fresh at the start of a request handler — never cache config in module-level variables
- Mutate the dict, then `save_config(cfg)` — never construct a new dict from scratch (would lose unknown fields)
- Check `config_exists()` AND non-empty `server`/`apiKey` before enabling auth-dependent features

### Threading

- Daemon threads only (`daemon=True`) — they must not hold resources that need cleanup on exit
- Use `threading.Event` for stop signals, not `threading.Condition` or manual flags
- `_lock.acquire()` / `with _lock:` — always use context manager form
- Never call blocking I/O inside `async def` route handlers — offload to a thread or background task

### FastAPI Patterns

- Form endpoints: `async def handler(field: str = Form(""))` with defaults — never raise on missing form fields
- Always return `RedirectResponse("/", status_code=303)` after mutations (Post/Redirect/Get)
- `JSONResponse` for AJAX polling endpoints (`/agent/status`, `/agent/logs`)
- HTML is rendered server-side via f-string template in `_render_page()` — no Jinja2

### Logging

```python
_log_buf: deque = deque(maxlen=500)

def _log(msg: str) -> None:
    with _log_lock:
        _log_buf.append(msg)
```

Use `_log("[component] message")` prefix convention everywhere. The webui log view is the primary debugging surface — be liberal with log messages in long-running operations.

### Error Handling

- Catch specific exceptions, not bare `except:`
- On recoverable errors in background threads: `_log(f"[component] ERROR: {exc}")` and return/continue — never let exceptions propagate and crash the daemon thread silently
- On fatal config errors: `sys.exit(1)` (see `save_config`)

---

## Tooling

### Environment

```bash
python3 -m venv venv
source venv/bin/activate     # or: venv\Scripts\activate on Windows
pip install -r requirements.txt
```

`make venv` automates this. Always use the venv — never install globally.

### Running Locally

```bash
make webui                           # start web UI on :8080
python offload-agent.py webui        # equivalent
python offload-agent.py cli serve    # headless agent (no UI)
```

### Packaging (PyInstaller)

```bash
make build    # produces dist/offload-agent (single binary)
make rebuild  # clean + build
```

The `.spec` file (`offload-agent.spec`) controls PyInstaller. Key flags:
- `--onefile` — single executable
- `--add-data 'app:app'` — bundle the app package
- `--add-data 'webui.py:.'` — bundle the webui module

After packaging, `getattr(sys, "frozen", False)` is `True` and `sys._MEIPASS` holds the extraction dir.

### macOS `.app` Build

```bash
bash build-mac.sh    # PyInstaller with --windowed, produces .app bundle
```

Entry point is `offload-agent-mac.py` (not `offload-agent.py`) to avoid showing a terminal.

### Dependencies

Add to `requirements.txt` — keep optional dependencies commented with a note explaining when they're needed. GPU detection libs (`pynvml`, `GPUtil`) are optional; guard their import with `try/except ImportError`.

```python
try:
    import pynvml
    HAS_PYNVML = True
except ImportError:
    HAS_PYNVML = False
```

---

## Key Patterns to Follow

### Adding a New Executor

1. Create `app/exec/mytype.py` with a function `execute_mytype(task, ...) -> dict`
2. Register in `app/core.py` dispatch table: `"mytype": execute_mytype`
3. Add capability detection in `app/capabilities.py` if it needs a runtime probe
4. Add the capability string to the UI checkbox list if it's user-selectable

### Adding a New Config Field

1. Read with `cfg.get("field", default)` — always provide a default
2. Write by mutating the loaded dict: `cfg["field"] = value; save_config(cfg)`
3. If the field affects UI state, handle it in `_render_page()` before the f-string

### Adding a New Route

```python
@app.post("/my/route")
async def my_route(field: str = Form("")):
    cfg = load_config()
    # do work
    save_config(cfg)
    return RedirectResponse("/", status_code=303)
```

For read-only AJAX:
```python
@app.get("/my/data")
async def my_data():
    return JSONResponse({"key": "value"})
```
