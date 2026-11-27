# Agent Capabilities

This document describes all built-in capabilities that OffloadMQ agents can register and execute.

## Capability Detection

Capabilities are automatically detected when an agent starts. The detection process:

1. Checks if required binaries are available in `PATH`
2. Verifies runtime dependencies are accessible
3. Registers only available capabilities with the server

Run `omq capabilities` to see detected capabilities on your system.

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

### Image Processing

#### `image_resize`

Resize images with Pillow. No GPU, no ComfyUI, no workflow to install — the capability
exists purely to keep "make this image smaller" off the generation nodes.

**Always available** — Pillow is a hard dependency of the agent, so this is detected on
every agent and registered by default (regular/opt-out tier).

Registered with the supported resampling filters as extended attributes:

```
image_resize[nearest;box;bilinear;hamming;bicubic;lanczos]
```

Clients submit the base capability `image_resize`. Input images come from the task's
`file_bucket`; `output_bucket` is required.

**Payload:**
```json
{
  "input_image": "photo.jpg",
  "method":      "lanczos",
  "mode":        "fit",
  "width":       1024,
  "height":      1024,
  "format":      "webp",
  "quality":     90
}
```

`mode` is `fit` (aspect preserved, default), `exact` (stretch) or `cover` (fill and
centre-crop); `scale` may be used instead of `width`/`height`. Omit `input_image` to
resize every image in the bucket.

**Response:**
```json
{
  "method":        "lanczos",
  "mode":          "fit",
  "image_count":   1,
  "output_bucket": "550e8400-...",
  "images": [
    {
      "filename": "photo.webp", "content_type": "image/webp",
      "file_uid": "a1b2c3d4-...", "bucket_uid": "550e8400-...",
      "width": 1024, "height": 683,
      "original_width": 4000, "original_height": 2667
    }
  ]
}
```

Full contract: [image-resize-api.md](image-resize-api.md).

#### `onnx.bgremove.*` — background removal

Cuts the subject out of each input image with an ONNX segmentation model. The output
is a transparent PNG/WebP, or the subject on a solid colour (PNG/WebP/JPEG), with
optional crop-to-subject. It is meant for game-character sprites from anime and
realistic images. There is one capability per installed BiRefNet model:
`onnx.bgremove.birefnet-general` (the default, for anime and realistic), `-portrait`
(people only) and `-lite` (small download).

**Availability:** `onnxruntime` plus the model file. On the agent, models are installed
with `omq bgremove install [model…]` or the web UI's **Background removal** page.
Remotely, use `slavemode.onnx-models-prepare` (name `bgremove-<model>`). Device, CPU
threads and session caching are agent settings (`omq bgremove config`). If the
configured device is missing from the agent's onnxruntime build, the capabilities are
not advertised. This is a regular (opt-out) capability. `output_bucket` is required.

```json
{ "format": "png", "background": "transparent", "crop": true, "padding": 16 }
```

Full contract and model comparison: [bgremove-api.md](bgremove-api.md).

---

### Shell Execution

#### `shell.*` — `shell.bash`, `shell.zsh`, `shell.posix`, `shell.pwsh`, `shell.cmd`, `shell.any`

Run a command in a workspace with an env map, credentials, input files and output
artifacts. Output streams live to the task log; non-zero exit = failed task.

**Availability:** per interpreter (bash/zsh/sh on Linux/macOS; Git Bash, pwsh, cmd on
Windows). `shell.any` = the agent's default shell. Sensitive — opt in per capability.

**Payload:** a bare command string, or
```json
{
  "command": "echo \"$GREETING\" && make dist",
  "workspace": "builds/${rand}",
  "env": {"GREETING": "hi"},
  "credentials": [{"name": "TOKEN", "type": "agent_env", "from": "CI_TOKEN"}],
  "artifacts": ["dist/**"]
}
```

**Response:**
```json
{
  "exit_code": 0, "stdout": "hi\n…", "stderr": "", "shell": "bash",
  "workspace": "/…/builds/3fa1c2d4e5b6", "duration_ms": 812,
  "artifacts": [{"path": "dist/app.tgz", "file_uid": "…", "bucket_uid": "…", "size": 1024, "sha256": "…"}]
}
```

Full contract (substitution grammar, credential types, masking, cleanup, artifacts):
[shell-api.md](shell-api.md).

---

#### `shellcmd.bash`

Legacy: execute a single bash command in the task data directory and return results (no live log, workspace, env, credentials or artifacts — use `shell.*` for those).

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
- Extended attributes are visible via `GET /management/capabilities/list/online_ext` (management Bearer token) or `POST /api/capabilities/list/online_ext` (client API key; key-filtered on base capability) for inspection

---

## Custom Capabilities

Agents can register custom capabilities beyond the built-in ones. Custom capabilities use extended attributes in brackets to declare their payload schema, enabling generic clients to auto-generate input forms.

**Example:**
```
custom.weather[city;units;days:int]
```

This registers a `custom.weather` capability whose payload expects three fields: `city` (string), `units` (string), and `days` (integer).

**In config file** (`~/.offloadmq-agent.json`):
```json
{
  "server": "http://localhost:3069",
  "api_key": "ak_live_...",
  "custom_caps": ["custom.weather[city;units;days:int]", "data.transform[query:text;format]"]
}
```

**In the dashboard:**
- Open the dashboard (`omq webui`)
- On the **Config** page, add the full capability string (including `[field;field:type]` attributes) to `custom_caps` and save
- Click **Rescan** on the **Capabilities** page to register the new capabilities

Custom capabilities require a matching executor in the agent to handle tasks. Without one, tasks will fail with "No routed executor". See the full convention — naming, payload schema, response format, and implementation guide — in **[Custom Capabilities Convention](custom-capabilities.md)**.

---

## Detecting Available Capabilities

### Via CLI

```bash
omq capabilities    # Detected capabilities
omq status          # Server, agent id, running state, registered capabilities
```

### Via Web UI

1. Start the dashboard: `omq webui`
2. Open `http://127.0.0.1:8090` in your browser
3. Open the **Capabilities** page (shows detected capabilities)
4. Click **Rescan** to re-detect capabilities

### Via Server Management API

```bash
curl -H "Authorization: Bearer <token>" \
  http://your-server:3069/management/capabilities/list/online
```

### Via Client API (extended strings)

Same JSON body style as task submission (`apiKey` field). Returns raw capability strings including brackets, scoped to capabilities the key may use:

```bash
curl -X POST http://your-server:3069/api/capabilities/list/online_ext \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"<your-client-api-key>"}'
```

See [tasks-api.md](tasks-api.md#get-online-capabilities-extended-client-filtered) for management override and error behavior.

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

## world.splat — VR Worlds

Converts an input-bucket `input_image` to a Gaussian-splat `scene.ply`,
`preview.png` and `depth.png` in the required output bucket. Discovery requires
ComfyUI and an installed img-utils depth workflow. See [VR Worlds](oai-worlds.md)
for the payload, bounds, file references and operational limits.

## world.sharp — Apple SHARP splats

Converts an input-bucket `input_image` to an [Apple SHARP](https://github.com/apple/ml-sharp)
Gaussian splat (`scene.ply`, 1,179,648 Gaussians, metric scale, OpenCV frame) plus a
`preview.png` lean contact sheet in the required output bucket. Perspective pictures
only (`mode=pano` fails). Optional `hfov` (20–120°) sets the focal length; without it
SHARP reads the EXIF focal length or assumes a 30 mm lens. Payload and output
contract: [VR Worlds](oai-worlds.md). Advertised as `world.sharp[ply;preview;metric]`.

**Not installed with the agent.** SHARP needs torch + CUDA (~6 GB venv) and a 2.8 GB
research-only checkpoint (Apple ML Research Model licence, see
`agent_v2/third_party/ml-sharp/LICENSE_MODEL`), so it lives in a private uv venv built
on demand. The source is the `agent_v2/third_party/ml-sharp` git submodule, bundled
into release binaries; `uv` must be on `PATH` to install.

| CLI | GUI (3D Worlds page) | Does |
|---|---|---|
| `omq sharp status` | Status card | Locations, installed revision / torch / device (file checks only) |
| `omq sharp config --venv-dir D --models-dir D --torch-index I` | Locations card | Change where the venv / model live (`''` = default) and the torch build: `auto` (CUDA 12.8 if `nvidia-smi` exists, CPU otherwise, PyPI on macOS), `cuda`, `cpu`, `pypi` or an index URL |
| `omq sharp install [--force]` | Install / Reinstall | Create the venv, install pinned torch + SHARP, download the model. `--force` rebuilds the venv; a valid model is kept |
| `omq sharp doctor [--fix]` | Doctor / Repair | Check source, uv, venv, `sharp` command, torch import + CUDA, model size, installed-vs-bundled version; `--fix` reinstalls only what failed |
| `omq sharp uninstall [--keep-model] [-y]` | Uninstall | Delete the venv (and the model) — the configured directories themselves stay |

Defaults: venv `~/.offload-agent/sharp/venv`, model `~/.offload-agent/sharp/models`
(settings `sharp_venv_dir`, `sharp_models_dir`, `sharp_torch_index` in
`~/.offloadmq-agent.json`). Install, repair and uninstall trigger a capability rescan,
so `world.sharp` appears or disappears without a restart (the GUI); after the CLI,
restart or rescan the agent. From a checkout: `task sharp:install`,
`task sharp:doctor [FIX=1]`, `task sharp:uninstall` in `agent_v2/`.

At run time the agent asks the ComfyUI at `comfyui_url` to unload its models (SHARP
peaks at ~7 GiB VRAM), then runs SHARP in the venv; cancellation or the task timeout
kills the process tree. On an RTX 5070 Ti a task takes ~20–30 s end to end.

## world.pano360 — 360° worlds from one picture (WorldGen recipe)

Extends a perspective `input_image` into a full 360° world, following
[WorldGen](https://github.com/ZiYang-xie/WorldGen)'s image-to-scene path on the local
ComfyUI: the picture is projected onto a 2:1 equirectangular canvas (`hfov`, `pitch`),
FLUX.1-dev + WorldGen's public panorama LoRA outpaints the rest of the sphere
(masked-latent inpainting + differential diffusion at 1600×800), a second pass rolls
the panorama 180° and re-inpaints the wrap seam, the original pixels are pasted back
and the result is splatted like `world.splat` (Lotus depth, pano mode). Uploads
`scene.ply`, `preview.png`, `depth.png` and `panorama.jpg` to the required output
bucket. Advertised as `world.pano360[ply;preview;pano;outpaint]`.

Payload (all optional except `input_image`; numbers are clamped):

| Key | Default | Range | Meaning |
|---|---|---|---|
| `prompt` | `a scene` | ≤ 2000 chars | What surrounds the picture; wrapped in WorldGen's "A high quality 360 panorama photo of … 360 consistent, omnidirectional" |
| `hfov` | 70 | 30–120° | Horizontal FOV of the picture — wider covers more of the sphere |
| `pitch` | 0 | −60–60° | Camera tilt; negative = looking down (shots from a hill or balcony) |
| `seed` | random | 0–2^53 | Outpaint seed (the seam pass uses `seed + 1`) |
| `steps` / `guidance` | 28 / 4.0 | 8–50 / 1–10 | FLUX sampling |
| `denoise` | 1.0 | 0.5–1.0 | Outpaint strength — below 1 leaves a diagonal patch-grid pattern |
| `max_width` | 1536 | 256–2048 | Splat grid width of the panorama (1 splat per pixel) |
| `near` / `far` / `fill_lean` | 1.2 / 50 / 0.25 | as `world.splat` | Depth mapping and hidden background layer |

`mode=pano` is rejected: a ready panorama goes to `world.splat`. The output adds
`coverage` (fraction of the sphere the picture covers), `models` (the ComfyUI files
used), `prompt_ids` and the effective `settings` (incl. `prompt`, `seed`).

**Requirements.** ComfyUI with the img-utils depth workflow (as `world.splat`), a
FLUX.1-dev UNET (any dev / Krea dev; Fill, Kontext and Schnell are not picked), CLIP-L,
T5-XXL (fp8 preferred), the FLUX VAE `ae.safetensors`, and WorldGen's
`worldgen_text2scene.safetensors` LoRA (35 MB, Apache-2.0). Models are auto-picked
from what ComfyUI lists; only the LoRA is downloaded by the agent, sha256-verified,
into ComfyUI's first `loras` folder (from `/internal/folder_paths`).

| CLI | GUI (360° Worlds page) | Does |
|---|---|---|
| `omq pano360 status` | Status card | Which ComfyUI models it would use and where the LoRA goes (four small ComfyUI requests) |
| `omq pano360 config --unet U --clip-l C --t5 T --vae V --lora-dir D` | Settings card | Pin a model as ComfyUI lists it, or the LoRA folder (`''` = auto) |
| `omq pano360 install [--force]` | Install / Reinstall LoRA | Download the LoRA (skips a verified copy; replaces a corrupt one in place) |
| `omq pano360 doctor [--fix]` | Doctor / Repair | ComfyUI reachable, 16 graph nodes, each model, LoRA listed + sha256, depth workflow; `--fix` re-downloads the LoRA |
| `omq pano360 uninstall [-y]` | Remove LoRA | Delete the LoRA wherever ComfyUI finds it; shared FLUX models are never touched |

Settings: `pano360_unet`, `pano360_clip_l`, `pano360_t5`, `pano360_vae`,
`pano360_lora_dir` (blank = auto). From a checkout: `task pano360:install`,
`task pano360:doctor [FIX=1]`, `task pano360:uninstall` in `agent_v2/`. On an RTX 5070 Ti
a task takes ~80 s (outpaint ~40 s, seam ~30 s, depth + splat ~6 s) and yields ~1.2 M
splats / ~78 MiB at `max_width` 1536.

## world.mirror — WorldMirror 2.0 splats (experimental)

Tencent HY-World 2.0's feed-forward model turns one perspective picture into a splat
world. Advertised as `world.mirror[ply;preview;experimental]`. Behaviour, payload and
how it compares with SHARP: [VR Worlds](oai-worlds.md#worldmirror-experimental).

**Off by default.** The [HY-World 2.0 Community License](https://github.com/Tencent-Hunyuan/HY-World-2.0/blob/main/License.txt)
does not apply in the European Union, the United Kingdom or South Korea, so using the
code, the weights or the generated worlds there is unlicensed. Nothing is installed or
advertised until the operator accepts it (`mirror_license_accepted`). Nothing of
Tencent's ships with the agent: the install fetches it from the publishers.

Needs an NVIDIA GPU (7.8–9.3 GiB VRAM), `uv`, `git`, ~6 GB for the venv and 4.9 GiB of
models. Before each run the agent asks ComfyUI to unload, and Ollama too unless
`mirror_free_ollama` is off (a loaded LLM pushes WorldMirror out of VRAM; turn it off
when the agent also serves chat). Runs have no time limit; cancelling the task stops
them. Install SHARP too: without it the world's scale is only estimated.

| CLI | GUI (**WorldMirror**) | Does |
|---|---|---|
| `omq mirror status` | Status card | Directory, licence, venv, code, model (no imports) |
| `omq mirror config --dir D --accept-license/--revoke-license --free-ollama/--keep-ollama` | Licence, GPU memory + Location cards | Set the directory (`''` = default), the licence acceptance or Ollama unloading |
| `omq mirror install --accept-license [--force]` | Install / Reinstall | venv with CUDA torch, sparse checkout at a pinned commit, sha256-verified downloads |
| `omq mirror doctor [--fix]` | Doctor / Repair | Licence, tools, code digest, model checksums, torch + CUDA, pipeline import |
| `omq mirror uninstall [--keep-models] [-y]` | Uninstall | Delete the venv, code and models; other files in the directory stay |

Settings: `mirror_dir` (blank = `~/.offload-agent/mirror`; holds `venv/`, `src/`,
`weights/`, `skyseg.onnx`, `uv-cache/`), `mirror_license_accepted`, `mirror_free_ollama`
(default on). From a checkout:
`task mirror:install ACCEPT=1`, `task mirror:doctor [FIX=1]`, `task mirror:uninstall`
in `agent_v2/`.
