# offload-client

Python agent client for [offloadmq](https://github.com/offloadmq). Registers with the server, polls for tasks, and executes them.

Can run as a plain Python script or as a self-contained single-file binary built with PyInstaller.

---

## Usage

```
offload-client <command> [options]

Commands:
  cli        Run the CLI agent (register, serve, etc.)
  webui      Start the web UI dashboard
  install    Install the binary or configure the system service

offload-client --help
```

### `cli` — agent CLI

Passes all arguments directly to the agent CLI. Works with only the core dependencies (no `fastapi`/`uvicorn` required).

```bash
# Register and start serving
offload-client cli register --server http://your-server:3069 --key ak_live_...
offload-client cli serve

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
offload-client cli register --help
offload-client cli serve --help
```

### `webui` — web dashboard

Starts a FastAPI web UI on port 8080 (default). From the UI you can configure the server URL and API key, select capabilities, start/stop the agent, and watch live logs.

Requires web dependencies: `fastapi`, `uvicorn[standard]`, `python-multipart`.

```bash
offload-client webui
offload-client webui --host 127.0.0.1 --port 9000
```

The webui runs register + serve internally (no subprocess) when you click **Start**.

### `install bin` — install the binary system-wide

Copies the running binary to a target directory and sets `rwxr-xr-x` permissions.

```bash
# Install to /usr/local/bin (default, requires sudo)
sudo offload-client install bin

# Install to a custom location
offload-client install bin --dest ~/bin
```

### `install systemd` — create a systemd service (Linux only)

Writes `/etc/systemd/system/offload-client.service`, enables it, and starts it.
The service runs `offload-client webui` with a 30-second startup delay after the network is online.

```bash
# Requires: Linux, binary already installed, sudo
sudo offload-client install systemd
sudo offload-client install systemd --bin-path /usr/local/bin/offload-client \
                                    --user myuser \
                                    --host 0.0.0.0 \
                                    --port 8080
```

Refuses to run on non-Linux platforms or if the binary is not found at `--bin-path`.

---

## Installation

### From binary (recommended)

Download the pre-built binary from the [Releases](../../releases) page and run:

```bash
chmod +x offload-client
sudo ./offload-client install bin          # copies to /usr/local/bin
sudo offload-client install systemd        # Linux: creates systemd service
```

### From source

```bash
git clone ...
cd offload-client

# Core only (cli command)
pip install requests psutil websocket-client typer colorlog pydantic

# With webui support
pip install -r requirements.txt

python offload-client.py cli register --server http://localhost:3069 --key ak_live_...
python offload-client.py cli serve
```

Or use make:

```bash
make venv       # create virtualenv + install all deps
make register   # register agent
make serve      # register + serve
make webui      # start web UI
```

### Build the binary yourself

```bash
make build          # build dist/offload-client
make rebuild        # clean + build
```

From the repo root:

```bash
make build-client   # same as above
make rebuild-client # clean + build
```

---

## Configuration

Saved to `.offload-client.json` in the working directory:

```json
{
  "server": "http://your-server:3069",
  "apiKey": "ak_live_...",
  "agentId": "22550957-9deb-4c98-bbdc-2e7649684fe0",
  "key": "7e17cecc-3209-498b-9839-58da9990ef4f",
  "jwtToken": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
  "capabilities": ["debug.echo", "shell.bash"],
  "custom_caps": []
}
```

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
