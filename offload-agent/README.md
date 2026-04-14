# offload-agent

Python agent for [offloadmq](https://github.com/offloadmq). Registers with the server, polls for tasks, and executes them.

Can run as a plain Python script or as a self-contained single-file binary built with PyInstaller.

---

## Usage

```
offload-agent <command> [options]

Commands:
  cli        Run the CLI agent (register, serve, etc.)
  webui      Start the web UI dashboard
  install    Install the binary or configure the system service

offload-agent --help
```

### `cli` — agent CLI

Passes all arguments directly to the agent CLI. Works with only the core dependencies (no `fastapi`/`uvicorn` required).

```bash
# Register and start serving
offload-agent cli register --server http://your-server:3069 --key ak_live_...
offload-agent cli serve

# One-liner with make
make register SERVER=http://your-server:3069 KEY=ak_live_...
make serve
```

Available sub-commands:

| Sub-command | Description |
|-------------|-------------|
| `register`  | Register this machine as an agent |
| `serve`     | Poll for and execute tasks (runs forever) |
| `sysinfo`   | Print detected system information |
| `ollama`    | Print detected Ollama model capabilities |

```bash
offload-agent cli register --help
offload-agent cli serve --help
```

### `webui` — web dashboard

The UI is a **React** single-page app (Vite, JSX, Tailwind) under `frontend/`. The Python process serves `frontend/dist` at `/` and exposes JSON/form APIs (`/api/state`, `/agent/*`, etc.). The previous server-rendered version is kept as `webui_backup.py` for reference.

From the UI you can:

- Configure server URL and API key
- View detected system info (OS, RAM, GPU) and Ollama models — rescanned on demand
- Select capabilities and manage ImgGen / ComfyUI workflows
- Toggle **Autostart on launch** — agent starts automatically when the webui starts (only when `--agent-autostart` is also passed)
- Start / stop the agent and watch live logs
- Install as a systemd service (Linux only, binary must be installed first)
- Windows / macOS login startup toggles when running a frozen app

Requires: **Node.js + npm** (to build `frontend/dist`), web Python deps `fastapi`, `uvicorn[standard]`, `python-multipart`.

**Development:** run the API on port 8080 (`python offload-agent.py webui --port 8080`) and in another terminal `cd frontend && npm run dev` (Vite proxies API routes to 8080).

```bash
offload-agent webui
offload-agent webui --host 127.0.0.1 --port 9000

# Start webui and honor the autostart config setting (used by the systemd service)
offload-agent webui --agent-autostart

# Enable autostart permanently (saves autostart=true to config) and start agent now
offload-agent webui --agent-autostart-enable
```

The webui runs register + serve internally (no subprocess) when you click **Start**.

#### Autostart behavior

| Launch | `autostart` in config | Result |
|---|---|---|
| `webui` (manual) | any | Never autostarts |
| `webui --agent-autostart` | `false` | Does not start |
| `webui --agent-autostart` | `true` | Autostarts agent |
| `webui --agent-autostart-enable` | set to `true` | Autostarts + persists |

The **Autostart on launch** checkbox in the UI writes `autostart` to config. The systemd service always passes `--agent-autostart`, so the checkbox controls whether the agent actually starts on boot.

#### Per-platform autostart summary

| Platform | Mechanism | How to enable | What runs at login |
|---|---|---|---|
| **Linux** | systemd service (`/etc/systemd/system/`) | `sudo offload-agent install systemd` or the **Install systemd service** button | `offload-agent webui --agent-autostart` (agent starts if `autostart=true` in config) |
| **macOS** | LaunchAgent plist (`~/Library/LaunchAgents/`) | `offload-agent install launchd` or the **Start with macOS** toggle in the UI | The `.app` bundle executable |
| **Windows** | Registry `HKCU\…\Run` | **Start with Windows** toggle in the UI (frozen `.exe` only) | `offload-agent.exe` |

### `install bin` — install the binary system-wide

Copies the running binary to a target directory and sets `rwxr-xr-x` permissions.

```bash
# Install to /usr/local/bin (default, requires sudo)
sudo offload-agent install bin

# Install to a custom location
offload-agent install bin --dest ~/bin
```

### `install systemd` — create a systemd service (Linux only)

Writes `/etc/systemd/system/offload-agent.service`, enables it, and starts it.
The service runs `offload-agent webui --agent-autostart` with a 30-second startup delay after the network is online, so the **Autostart on launch** checkbox in the UI controls whether the agent actually starts on boot.

```bash
# Requires: Linux, binary already installed, sudo
sudo offload-agent install systemd
sudo offload-agent install systemd --bin-path /usr/local/bin/offload-agent \
                                    --user myuser \
                                    --host 0.0.0.0 \
                                    --port 8080
```

Refuses to run on non-Linux platforms or if the binary is not found at `--bin-path`.

You can also install the service directly from the **webui** using the **Service** card. The button is grayed out with a reason if the platform is not Linux or the binary is not installed.

### `install launchd` — create a macOS LaunchAgent (macOS only)

Writes `~/Library/LaunchAgents/com.offloadmq.agent.plist` and loads it with `launchctl`. The agent app will launch automatically at every login.

When running from the built `.app` bundle this works without arguments:

```bash
"dist/Offload Agent.app/Contents/MacOS/Offload Agent" install launchd
```

When running from source, pass `--app-path` explicitly:

```bash
offload-agent install launchd --app-path /path/to/offload-agent
```

To remove the LaunchAgent:

```bash
launchctl unload ~/Library/LaunchAgents/com.offloadmq.agent.plist
rm ~/Library/LaunchAgents/com.offloadmq.agent.plist
```

The **Start with macOS** checkbox in the web UI **Service** card does the same — it is shown only when running inside the frozen `.app` bundle.

---

## Installation

### From binary (recommended)

Download the pre-built binary from the [Releases](../../releases) page and run:

```bash
chmod +x offload-agent
sudo ./offload-agent install bin          # copies to /usr/local/bin
sudo offload-agent install systemd        # Linux: creates systemd service
offload-agent install launchd             # macOS: creates LaunchAgent
```

### From source

```bash
git clone ...
cd offload-agent
python3 -m pip install --user pdm
pdm sync --group dev --group build

pdm run python offload-agent.py cli register --server http://localhost:3069 --key ak_live_...
pdm run python offload-agent.py cli serve
```

Or use make:

```bash
make venv       # sync dependencies via pdm
make register   # register agent
make serve      # register + serve
make webui      # start web UI
```

### Build the binary yourself

#### Linux (CLI binary)

Requires **Node.js** (npm runs `frontend` production build before PyInstaller).

```bash
make build          # npm ci + vite build + PyInstaller -> dist/offload-agent
make rebuild        # clean + build
```

From the repo root:

```bash
make build-client   # same as above
make rebuild-client # clean + build
```

#### Linux: build + install as a headless systemd service

If you want the agent to run permanently on a Linux node without any web UI, use the `install-systemd` make target. It builds the binary from source, installs it to `/usr/local/bin`, registers the agent with the server, and creates a systemd service that runs `cli serve` (no web UI, no open port).

```bash
make install-systemd \
  SERVER=https://your-offloadmq-server \
  KEY=<agent_api_key>
```

If the binary is already installed and you only need to re-register or set up the service:

```bash
make register-systemd \
  SERVER=https://your-offloadmq-server \
  KEY=<agent_api_key>
```

Check the service after installation:

```bash
systemctl status offload-agent
journalctl -u offload-agent -f
```

#### macOS (.app bundle with tray icon)

A shell build script produces a self-contained `Offload Agent.app` with a menu-bar tray icon.

Prerequisites: Python 3.10+ and **Node.js** (npm) on PATH.

```bash
cd offload-agent
./build-mac.sh
```

The output is `dist/Offload Agent.app`. Double-click it (or drag to `/Applications`) — the web UI opens in your default browser at `http://127.0.0.1:8080` and a tray icon appears in the menu bar.

To enable autostart at login, use the **Start with macOS** toggle in the web UI's **Service** card, or run from the terminal:

```bash
"dist/Offload Agent.app/Contents/MacOS/Offload Agent" install launchd
```

The app uses `LSUIElement = true` in its `Info.plist`, so it does not appear in the Dock — only in the menu bar.

#### Windows (.exe with tray icon)

A PowerShell build script produces a standalone `.exe` that runs the web UI
without a console window and opens the browser automatically on launch.

Prerequisites: Python 3.10+ and **Node.js** (npm) on PATH.

```powershell
cd offload-agent
.\build-windows.ps1
```

The output is `dist\offload-agent.exe`. Double-click it to start — the web UI
opens in your default browser at `http://127.0.0.1:8080`.

---

## Configuration

Saved to `.offload-agent.json` in the working directory:

```json
{
  "server": "http://your-server:3069",
  "apiKey": "ak_live_...",
  "agentId": "22550957-9deb-4c98-bbdc-2e7649684fe0",
  "key": "7e17cecc-3209-498b-9839-58da9990ef4f",
  "jwtToken": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
  "capabilities": ["debug.echo", "shell.bash"],
  "custom_caps": [],
  "autostart": false,
  "slavemode-allowed-caps": ["slavemode.force-rescan"]
}
```

| Field | Description |
|---|---|
| `server` | OffloadMQ server URL |
| `apiKey` | Agent registration API key |
| `agentId`, `key`, `jwtToken` | Set automatically after registration |
| `capabilities` | Active capability list |
| `custom_caps` | User-defined extra capabilities |
| `autostart` | If `true` and `--agent-autostart` is passed, agent starts when webui launches |
| `slavemode-allowed-caps` | JSON array of allowed slavemode capabilities (empty by default — all disabled) |

---

## Built-in capabilities

| Capability      | Description                     |
|-----------------|---------------------------------|
| `debug.echo`    | Echo task payload back           |
| `shell.bash`    | Execute bash scripts with streaming output |
| `shellcmd.bash` | Execute single shell commands    |
| `docker.any`    | Run any Docker image             |
| `docker.python-slim` | Run `python:*-slim*` images only |
| `docker.node`   | Run `node:*` images only         |
| `tts.kokoro`    | Text-to-speech via Kokoro        |
| `llm.*`         | LLM inference (auto-detected via Ollama) |
| `slavemode.force-rescan` | Re-detect capabilities and push updated list to server |

See [docs/agent-capabilities.md](../../docs/agent-capabilities.md) for detailed capability documentation, payload schemas, and usage examples.

---

## Slavemode Capabilities

Slavemode capabilities let the server instruct the agent to perform **control operations on itself** — capability rescans, config reloads, and other self-management tasks.

**By default, all slavemode capabilities are disabled.** An agent only executes a slavemode task if the capability is explicitly listed in the `slavemode-allowed-caps` config key.

### Managing Permissions

Enable and disable slavemode capabilities via the CLI:

```bash
# Show which slavemode capabilities are allowed
offload-agent cli slavemode status

# Allow all slavemode capabilities
offload-agent cli slavemode allow-all

# Deny all slavemode capabilities
offload-agent cli slavemode deny-all

# Allow a specific capability
offload-agent cli slavemode allow slavemode.force-rescan

# Deny a specific capability
offload-agent cli slavemode deny slavemode.force-rescan
```

Or manage the `slavemode-allowed-caps` key directly in the config file:

```json
{
  "slavemode-allowed-caps": ["slavemode.force-rescan"]
}
```

The Web UI also includes a **Slavemode** section (amber styling) in the Capabilities tab for managing permissions.

### Available Capabilities

**`slavemode.force-rescan`** — Re-detect all agent capabilities and push the updated list to the server. Useful when Ollama models are installed, Docker daemon starts, or custom capabilities are added without restarting the agent.

See [docs/slavemode-capabilities.md](../../docs/slavemode-capabilities.md) for complete behavior, payload schemas, server-side usage, and troubleshooting.

---

## Dependencies

**Core** (required for `cli`):
- `requests`, `psutil`, `websocket-client`, `typer`, `colorlog`, `pydantic`

**Web UI** (required for `webui`):
- `fastapi`, `uvicorn[standard]`, `python-multipart`

**Optional**:
- `GPUtil`, `pynvml` — GPU detection
- `boto3` — AWS integration

Dependency management uses `pdm` with:
- runtime dependencies in `pyproject.toml` `[project.dependencies]`
- `build` group for PyInstaller
- `dev` group for mypy + typing stubs
