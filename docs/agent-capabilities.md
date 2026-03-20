# Agent Capabilities

This document describes all built-in capabilities that OffloadMQ agents can register and execute.

## Capability Detection

Capabilities are automatically detected when an agent starts. The detection process:

1. Checks if required binaries are available in `PATH`
2. Verifies runtime dependencies are accessible
3. Registers only available capabilities with the server

Run `offload-agent cli sysinfo` to see detected capabilities on your system.

---

## Built-in Capabilities

### Debug

#### `debug.echo`

Echo the task payload back. Useful for testing the connection and payload serialization.

**Always available** — built-in capability with no external dependencies.

**Payload:**
```json
{
  "message": "hello world"
}
```

**Response:**
```json
{
  "stdout": "{...payload...}",
  "stderr": ""
}
```

---

### Shell Execution

#### `shell.bash`

Execute bash scripts with streaming output. Each line of stdout/stderr is sent to the server in real-time.

**Availability:** Linux/macOS (requires `bash` in PATH)

**Payload:**
```json
"#!/bin/bash\necho 'Hello'\nls -la"
```
or
```json
{
  "command": "echo 'Hello'\nls -la"
}
```

**Response:**
```json
{
  "stdout": "Hello\n...",
  "stderr": "..."
}
```

---

#### `shellcmd.bash`

Execute a single shell command and return results. Like `shell.bash` but blocks until completion before streaming.

**Availability:** Linux/macOS (requires `bash` in PATH)

**Payload:**
```json
"echo 'Hello World'"
```
or
```json
{
  "command": "echo 'Hello World'"
}
```

**Response:**
```json
{
  "stdout": "Hello World\n",
  "stderr": "",
  "return_code": 0
}
```

---

### Docker

Run Docker containers with automatic cleanup, timeout protection, and streaming output.

#### `docker.any`

Run any Docker image without restrictions.

**Availability:** Requires Docker daemon accessible (`docker ps` succeeds)

**Payload:**
```json
{
  "image": "alpine:latest",
  "command": ["echo", "Hello from Docker"],
  "env": {
    "VAR1": "value1"
  },
  "timeout": 60
}
```

**Payload Fields:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `image` | string | ✅ | — | Docker image name (e.g., `python:3.12-slim`, `node:20`) |
| `command` | string \| array | ❌ | — | Command to run in the container (can be string or list of arguments) |
| `env` | object | ❌ | `{}` | Environment variables to pass (`{"VAR": "value"}`) |
| `timeout` | number | ❌ | `60` | Container timeout in seconds; container is killed if it exceeds this duration |

**Response:**
```json
{
  "stdout": "Hello from Docker\n",
  "stderr": "",
  "exit_code": 0
}
```

**Example: Run a Python script**
```json
{
  "image": "python:3.12-slim",
  "command": ["python", "-c", "print('Hello'); import os; print(os.environ.get('NAME', 'World'))"],
  "env": {
    "NAME": "Docker"
  },
  "timeout": 30
}
```

**Example: Run a Node.js app**
```json
{
  "image": "node:20-alpine",
  "command": ["node", "-e", "console.log('Node.js: ' + process.version)"],
  "timeout": 30
}
```

---

#### `docker.python-slim`

Run only `python:*-slim*` images. Useful for restricting workloads to lightweight Python images.

**Image allowlist:** Must start with `python:` and contain `-slim` in the tag.

**Valid examples:**
- `python:3.12-slim`
- `python:3.11-slim-bookworm`
- `python:3-slim`
- `python:latest-slim`

**Invalid examples (will be rejected):**
- `python:3.12` (no `-slim`)
- `python:3.12-alpine` (contains `-alpine`, not `-slim`)
- `node:20-slim` (not a Python image)

**Payload:** Same as `docker.any`

**Example:**
```json
{
  "image": "python:3.12-slim",
  "command": ["python", "-c", "import sys; print(f'Python {sys.version}')"],
  "timeout": 30
}
```

---

#### `docker.node`

Run only `node:*` images. Useful for restricting workloads to Node.js containers.

**Image allowlist:** Must start with `node:`

**Valid examples:**
- `node:20`
- `node:20-alpine`
- `node:18-slim`
- `node:lts-alpine`

**Invalid examples (will be rejected):**
- `node` (missing tag)
- `nodejs:20` (wrong image name)
- `python:3-slim` (not a Node image)

**Payload:** Same as `docker.any`

**Example:**
```json
{
  "image": "node:20-alpine",
  "command": ["node", "-e", "console.log(process.version); console.log(process.env.MSG)"],
  "env": {
    "MSG": "Hello from Node"
  },
  "timeout": 30
}
```

---

### Docker Implementation Details

**Container execution:**
- Containers run with `--rm` flag — automatically removed after execution
- Containers are named `offloadmq-<task_id>` for targeted cleanup
- Output is streamed in real-time as the container runs

**Timeout handling:**
- Timer starts when the container is created
- If the container doesn't exit within the timeout, it is killed via `docker kill`
- Response status is `failure` with message "Container timed out after Xs"

**Image restrictions:**
- `docker.python-slim` and `docker.node` enforce image allowlists
- Attempting to run a restricted image returns a failure response with error details
- `docker.any` has no restrictions

**Error handling:**
- Missing `image` field → failure with "No 'image' provided in payload"
- Invalid image for capability → failure with "Image '...' not allowed for capability '...'"
- Container exit code non-zero → failure with stderr (if available) or exit code message
- Container timeout → failure with "Container timed out after Xs"

---

### Text-to-Speech

#### `tts.kokoro`

Convert text to speech using the Kokoro TTS service. Requires Kokoro server to be running.

**Availability:** Requires Kokoro API endpoint at `http://localhost:8880` (configurable via `KOKORO_API_URL` env var)

**Payload:**
```json
{
  "text": "Hello, this is a test",
  "voice": "af_bella",
  "speed": 1.0
}
```

**Response:**
```json
{
  "audio_url": "data:audio/wav;base64,...",
  "duration_ms": 1234
}
```

---

### LLM (Large Language Models)

#### `llm.*`

Run LLM inference tasks via Ollama. Capability names are auto-generated from installed models and include extended attributes about each model.

**Example capability strings:**
- `llm.mistral:7b` — base capability
- `llm.mistral:7b[vision;8b]` — extended with attributes (model size, features)
- `llm.qwen2.5vl:7b[vision;size:5Gb;tools]` — multi-attribute (vision, size estimate, tool use)

**Availability:**
- Requires Ollama server running locally (default: `http://localhost:11434`)
- At least one model must be installed
- Auto-detected by running `ollama list`
- Configurable via `OLLAMA_ROOT_URL` env var (default: `http://localhost:11434`)

---

**Payload Schema:**

```json
{
  "model": "mistral:7b",
  "prompt": "Tell me a short joke",
  "temperature": 0.7,
  "top_p": 0.9,
  "top_k": 40,
  "max_tokens": 512,
  "system": "You are a helpful assistant.",
  "stream": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `model` | string | ✅ | — | Model name (e.g., `mistral:7b`, `neural-chat:7b`, `qwen2.5vl:7b`) |
| `prompt` | string | ✅ | — | Input prompt for the model |
| `temperature` | number | ❌ | `0.7` | Randomness (0.0-2.0); lower = more deterministic |
| `top_p` | number | ❌ | `0.9` | Nucleus sampling threshold (0.0-1.0) |
| `top_k` | number | ❌ | `40` | Top-k sampling; only consider top k tokens |
| `max_tokens` | number | ❌ | — | Maximum tokens to generate |
| `system` | string | ❌ | — | System prompt to set context |
| `stream` | boolean | ❌ | `false` | Stream response chunks (not currently supported) |

---

**Response:**

```json
{
  "response": "Why did the AI go to school? To improve its learning model!",
  "tokens_per_second": 45.3,
  "total_tokens": 128,
  "model": "mistral:7b",
  "duration_ms": 2830
}
```

| Field | Type | Description |
|-------|------|-------------|
| `response` | string | Generated text from the model |
| `tokens_per_second` | number | Generation speed |
| `total_tokens` | number | Total tokens generated |
| `model` | string | Model name that was used |
| `duration_ms` | number | Total inference time in milliseconds |

---

**Example: Mistral 7B (general purpose)**
```json
{
  "model": "mistral:7b",
  "prompt": "What is machine learning?",
  "temperature": 0.5,
  "max_tokens": 256
}
```

**Example: Neural Chat (conversational)**
```json
{
  "model": "neural-chat:7b",
  "system": "You are a helpful assistant specialized in Python programming.",
  "prompt": "How do I reverse a list in Python?",
  "temperature": 0.3
}
```

**Example: Qwen with vision support**
```json
{
  "model": "qwen2.5vl:7b",
  "prompt": "Describe this image: [image context or reference]",
  "max_tokens": 512
}
```

---

**Installing and Managing Ollama**

**Install Ollama:**
- Download from [ollama.ai](https://ollama.ai)
- Supports Linux, macOS, and Windows
- Runs as a background service on `http://localhost:11434`

**List installed models:**
```bash
offload-agent cli ollama
```
or
```bash
ollama list
```

**Download a model:**
```bash
# Popular lightweight models
ollama pull mistral:7b          # 4.1GB - fast, good quality
ollama pull neural-chat:7b      # 4.1GB - optimized for chat
ollama pull qwen2:7b            # 5.0GB - multilingual
ollama pull phi:latest          # 2.6GB - small, fast
ollama pull llama2:7b-chat      # 3.8GB - instruction-tuned

# Larger models (require more VRAM)
ollama pull mistral:13b         # 7.4GB
ollama pull neural-chat:13b     # 7.4GB
ollama pull llama2:13b-chat     # 7.3GB
```

**Remove a model:**
```bash
ollama rm mistral:7b
```

**Check server status:**
```bash
curl http://localhost:11434
```

---

**Extended Attributes**

Ollama model capabilities include extended attributes in brackets to describe features:

**Format:** `llm.<model>:<size>[attribute1;attribute2;...]`

**Common attributes:**
- `vision` — supports image analysis
- `tools` — supports function/tool calling
- `quantized` — quantized model (faster, less VRAM)
- `size:<estimate>` — estimated model size (e.g., `size:4Gb`, `size:7Gb`)
- `chat` — optimized for conversation

**Examples:**
- `llm.mistral:7b[size:4Gb]` — Mistral 7B (~4GB)
- `llm.qwen2.5vl:7b[vision;size:5Gb;tools]` — Qwen with vision, tools, ~5GB
- `llm.llama2:13b-chat[size:7Gb;chat]` — Llama2 chat optimized

---

**Performance Considerations**

**VRAM Requirements:**
- 7B parameters: ~4-6 GB VRAM
- 13B parameters: ~8-10 GB VRAM
- 34B parameters: ~20-24 GB VRAM
- Larger models require GPU or may use CPU (much slower)

**Speed Tips:**
1. Use smaller models (7B) for real-time applications
2. Use GPU if available (Ollama auto-detects NVIDIA/Metal)
3. Reduce `max_tokens` to limit generation time
4. Increase `temperature` for faster (more random) responses

**Monitoring:**
```bash
# Check which models are loaded
ollama list

# View running processes
ps aux | grep ollama
```

---

**Troubleshooting**

**Ollama not detected:**
```bash
# Check if server is running
curl http://localhost:11434

# Start Ollama server
ollama serve
```

**Model not found:**
```bash
# List available models
ollama list

# Download the model
ollama pull mistral:7b

# Restart the agent to refresh capabilities
```

**Out of memory errors:**
- Use a smaller model (7B instead of 13B)
- Reduce `max_tokens`
- Check available VRAM: `nvidia-smi` (NVIDIA) or system settings (macOS/Windows)

**Slow generation:**
- Model is running on CPU (no GPU detected)
- Check: `ollama list` shows "[cpu]" or "[gpu]"
- Install appropriate drivers (NVIDIA CUDA, Metal for macOS)

---

## Capability Matching

When a client submits a task, the scheduler matches it to agents based on:

1. **Base capability** — stripped of extended attributes (brackets)
   - Task requests: `"docker.any"` (no brackets)
   - Agent capability: `"docker.any"` or `"docker.any[...]"` → both match

2. **Tier** — higher-tier agents get priority
   - Tasks are reserved for higher-tier agents when available
   - Lower-tier agents still receive tasks when no higher-tier agents are online

3. **Capacity** — agent's concurrent task limit

---

## Extended Capability Attributes

Some capabilities include extended attributes in brackets to provide additional metadata. These are for informational purposes and do not affect task matching.

**Format:** `capability.name[attribute1;attribute2;...]`

**Examples:**
- `llm.mistral:7b[vision;tools;quantized]` — LLM with vision support, tool use, and quantization
- `docker.any[gpu;cuda12.1]` — Docker with GPU support (hypothetical, not currently used)

**Matching behavior:**
- Attributes are **stripped before matching**
- Task capability: `"llm.mistral:7b"` matches agent capability: `"llm.mistral:7b[vision;tools]"`
- Extended attributes are visible in management API (`/capabilities/list/online_ext`) for inspection

---

## Custom Capabilities

Agents can register custom capabilities beyond the built-in ones. Custom capabilities use extended attributes in brackets to declare their payload schema, enabling generic clients to auto-generate input forms.

**Example:**
```
custom.weather[city;units;days:int]
```

This registers a `custom.weather` capability whose payload expects three fields: `city` (string), `units` (string), and `days` (integer).

**In config file** (`.offload-agent.json`):
```json
{
  "server": "http://localhost:3069",
  "apiKey": "ak_live_...",
  "custom_caps": ["custom.weather[city;units;days:int]", "data.transform[query:text;format]"]
}
```

**In web UI:**
- Open the web UI (`offload-agent webui`)
- On the **Capabilities** card, click **+ Add custom capability**
- Enter the full capability string including `[field;field:type]` attributes
- Click **Register** to register with the new capabilities

Custom capabilities require a matching executor in the agent to handle tasks. Without one, tasks will fail with "Unknown capability". See the full convention — naming, payload schema, response format, and implementation guide — in **[Custom Capabilities Convention](custom-capabilities.md)**.

---

## Detecting Available Capabilities

### Via CLI

```bash
offload-agent cli sysinfo    # System info + detected capabilities
offload-agent cli ollama     # List Ollama models (if available)
```

### Via Web UI

1. Start the web UI: `offload-agent webui`
2. Open `http://127.0.0.1:8080` in your browser
3. View the **System Info** card (shows detected capabilities)
4. Click **Rescan** to re-detect capabilities

### Via Server Management API

```bash
curl -H "Authorization: Bearer <token>" \
  http://your-server:3069/management/capabilities/list/online
```

---

## Troubleshooting

### Docker capabilities not detected

**Check:** `docker ps` succeeds when run manually
```bash
docker ps
```

If this fails, Docker daemon is not running. Start Docker and restart the agent.

### Python-slim image rejected

Make sure the image tag contains `-slim`:
- ✅ `python:3.12-slim`
- ✅ `python:3.12-slim-bookworm`
- ❌ `python:3.12` (missing `-slim`)
- ❌ `python:3.12-alpine` (has `-alpine`, not `-slim`)

### Container times out

Check if the container command is hanging or too slow. Increase the `timeout` field or check the logs.

### Ollama models not detected

```bash
# Check if Ollama is running
curl http://localhost:11434

# List installed models
ollama list

# Pull a model if none are installed
ollama pull mistral:7b
```

Then restart the agent or rescan capabilities via the web UI.
