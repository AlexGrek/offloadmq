# OpenAI API Proxy for OffloadMQ

Translates OpenAI/Ollama API requests into OffloadMQ tasks, distributing LLM inference
to remote agents that have Ollama installed. Supports both blocking and streaming responses.

## Architecture

```
Your app  →  proxy (this)  →  OffloadMQ server  →  remote agent(s) with Ollama
              :11435              :3069                  Ollama :11434
```

The proxy runs on a non-default port (`:11435` in the examples below) because
your local Ollama is already occupying `:11434`.

---

## Prerequisites

- Python 3.11+
- OffloadMQ server built and ready (`cargo build` in the repo root)
- At least one agent machine with Ollama installed **and models pulled**
- The agent machine can be the same machine (agent will hit its local Ollama)

---

## Step 1 — Start the OffloadMQ server

From the repo root:

```bash
make dev-mq
```

The server binds to `0.0.0.0:3069` by default (configure in `.env`).

Check the default credentials in `.env`:

```
CLIENT_API_KEYS="client_secret_key_123"
AGENT_API_KEYS="ak_live_7f8e9d2c1b4a6f3e8d9c2b1a4f6e8d9c2b1a4f6e"
```

---

## Step 2 — Start the agent

The agent auto-discovers Ollama models on the machine where it runs and registers
them as `llm.<model-name>` capabilities (e.g. `llm.mistral`, `llm.llama3`).

**Important:** the agent always connects to its own local Ollama at `127.0.0.1:11434`,
so it must be run on a machine that has Ollama with models installed. It will not work
if `ollama list` returns nothing.

```bash
cd offload-agent

# One-time setup
make venv

# Register with the server, then start polling for tasks.
# The Makefile default key matches .env — override with KEY=... if needed.
make serve SERVER=http://localhost:3069
```

`make serve` calls `register` first (which saves credentials to `.offload-agent.json`)
then starts `serve`. On subsequent runs you can also call them separately:

```bash
# Register only (re-run after server restarts)
make register SERVER=http://localhost:3069

# Serve only (if already registered)
bash -c "source venv/bin/activate && python offload-agent.py cli serve"
```

Verify the agent is online — you should see its detected models in the output, e.g.:

```
Capabilities: ['debug.echo', 'llm.mistral', 'llm.llama3', 'shell.bash']
✅ Ping test successful - agent is ready!
```

---

## Step 3 — Start the proxy

Because your local Ollama is already on `:11434`, run the proxy on `:11435`:

```bash
cd openai-api-proxy

# One-time setup
make venv

# Start on port 11435 (avoids conflict with local Ollama on 11434)
.venv/bin/python proxy.py --port 11435 --server http://localhost:3069 --api-key client_secret_key_123
```

Or with make (uses default port 11434 — only if you're not running local Ollama):

```bash
make serve
```

On startup the proxy prints the online capabilities it found:

```
INFO  Online LLM capabilities: llm.mistral, llm.llama3
INFO  Starting OpenAI API proxy on 127.0.0.1:11435
INFO  Endpoints:
INFO    OpenAI:  POST http://127.0.0.1:11435/v1/chat/completions
INFO    Ollama:  POST http://127.0.0.1:11435/api/chat
INFO    Models:  GET  http://127.0.0.1:11435/v1/models
```

---

## Step 4 — Run the integration tests

The tests require all three services to be running (server + agent + proxy).

```bash
cd openai-api-proxy

# If proxy is on the default port 11434:
make test

# If proxy is on a non-default port (e.g. 11435), set OPENAI_PROXY_URL:
OPENAI_PROXY_URL=http://localhost:11435 .venv/bin/pytest test_proxy.py -v
```

> **Note:** Tests that require a model will be automatically skipped with
> `pytest.skip` if no LLM agents are online. Non-model tests (root check,
> model listing, error cases) always run.

Expected output when an agent with models is online:

```
test_proxy.py::test_list_models_openai              PASSED
test_proxy.py::test_list_models_ollama              PASSED
test_proxy.py::test_root_ollama_compat              PASSED
test_proxy.py::test_chat_completion_non_streaming   PASSED
test_proxy.py::test_chat_completion_streaming       PASSED
test_proxy.py::test_ollama_chat_non_streaming       PASSED
test_proxy.py::test_ollama_chat_streaming           PASSED
test_proxy.py::test_missing_model                   PASSED
test_proxy.py::test_missing_messages                PASSED
```

---

## Pointing a client at the proxy

Any OpenAI or Ollama client can be redirected to the proxy by changing the base URL.

**curl (OpenAI format):**
```bash
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**curl (streaming):**
```bash
curl http://localhost:11435/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

**curl (Ollama native):**
```bash
curl http://localhost:11435/api/chat \
  -d '{
    "model": "mistral",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

**Python openai SDK:**
```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:11435/v1", api_key="unused")
response = client.chat.completions.create(
    model="mistral",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

---

## How streaming works

Non-streaming requests use `POST /api/task/submit_blocking` — the HTTP connection
stays open until an agent finishes, then the full response is returned.

Streaming requests use non-urgent persistent tasks:
1. Proxy submits the task via `POST /api/task/submit` (`urgent: false`)
2. The agent calls Ollama with `stream: true` and sends buffered token chunks
   to the server as progress updates every ~2 seconds
3. The proxy polls `POST /api/task/poll/{cap}/{id}` at 0.5s intervals,
   detecting new content in the `log` field and emitting SSE chunks immediately

---

## CLI reference

```
proxy.py [--port PORT] [--host HOST] [--server URL] [--api-key KEY] [--log-level LEVEL]

  --port        Port to listen on (default: 11434)
  --host        Bind address (default: 127.0.0.1)
  --server      OffloadMQ server URL (default: http://localhost:3069)
  --api-key     OffloadMQ client API key (default: client_secret_key_123)
  --log-level   debug | info | warning | error (default: info)
```
