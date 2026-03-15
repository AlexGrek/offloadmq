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

Starts a FastAPI web UI on port 8080 (default). From the UI you can:

- Configure server URL and API key
- View detected system info (OS, RAM, GPU) and Ollama models — rescanned on demand
- Select capabilities
- Toggle **Autostart on launch** — agent starts automatically when the webui starts (only when `--agent-autostart` is also passed)
- Start / stop the agent and watch live logs
- Install as a systemd service (Linux only, binary must be installed first)

Requires web dependencies: `fastapi`, `uvicorn[standard]`, `python-multipart`.

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

---

## Installation

### From binary (recommended)

Download the pre-built binary from the [Releases](../../releases) page and run:

```bash
chmod +x offload-agent
sudo ./offload-agent install bin          # copies to /usr/local/bin
sudo offload-agent install systemd        # Linux: creates systemd service
```

### From source

```bash
git clone ...
cd offload-agent

# Core only (cli command)
pip install requests psutil websocket-client typer colorlog pydantic

# With webui support
pip install -r requirements.txt

python offload-agent.py cli register --server http://localhost:3069 --key ak_live_...
python offload-agent.py cli serve
```

Or use make:

```bash
make venv       # create virtualenv + install all deps
make register   # register agent
make serve      # register + serve
make webui      # start web UI
```

### Build the binary yourself

#### Linux / macOS

```bash
make build          # build dist/offload-agent
make rebuild        # clean + build
```

From the repo root:

```bash
make build-client   # same as above
make rebuild-client # clean + build
```

#### Windows

A PowerShell build script produces a standalone `.exe` that runs the web UI
without a console window and opens the browser automatically on launch.

Prerequisites: Python 3.10+ on PATH.

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
  "autostart": false
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

---

## Built-in capabilities

| Capability      | Description                     |
|-----------------|---------------------------------|
| `debug.echo`    | Echo task payload back           |
| `shell.bash`    | Execute bash scripts             |
| `shellcmd.bash` | Execute single shell commands    |
| `tts.kokoro`    | Text-to-speech via Kokoro        |
| `llm.*`         | LLM inference (auto-detected via Ollama) |

---

## Dependencies

**Core** (required for `cli`):
- `requests`, `psutil`, `websocket-client`, `typer`, `colorlog`, `pydantic`

**Web UI** (required for `webui`):
- `fastapi`, `uvicorn[standard]`, `python-multipart`

**Optional**:
- `GPUtil`, `pynvml` — GPU detection
- `boto3` — AWS integration
