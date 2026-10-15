# OpenRouter-compatible API (`/api/v1`)

OffloadMQ exposes an OpenAI / OpenRouter-compatible API, so existing clients
can use it in place of OpenRouter. These include the `openai` SDKs, LangChain,
LiteLLM, Open WebUI and Continue. A client switches over by changing two things:

| | OpenRouter | OffloadMQ |
|---|---|---|
| Base URL | `https://openrouter.ai/api/v1` | `https://<offloadmq-host>/api/v1` |
| API key | `sk-or-...` | your regular OffloadMQ **client API key** |

Each chat completion runs as an urgent `llm.<model>` task on an agent that
serves that model through Ollama. The task is submitted for you. Nothing else
from the [Task API](tasks-api.md) is needed.

Implementation: [src/api/openrouter/](../src/api/openrouter/).

## Quick start

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3069/api/v1", api_key="client_secret_key_123")

resp = client.chat.completions.create(
    model="qwen3:8b",
    messages=[{"role": "user", "content": "Say hi"}],
)
print(resp.choices[0].message.content)

for chunk in client.chat.completions.create(
    model="qwen3:8b", messages=[{"role": "user", "content": "Count to 5"}], stream=True
):
    print(chunk.choices[0].delta.content or "", end="")
```

```bash
curl -N http://localhost:3069/api/v1/chat/completions \
  -H "Authorization: Bearer client_secret_key_123" \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3:8b", "stream": true, "messages": [{"role": "user", "content": "hi"}]}'
```

## Authentication

- Send `Authorization: Bearer <client API key>`. `X-API-Key: <key>` also works.
- The key's capability list applies: a key may only use the `llm.*` models it
  is allowed. Wildcards such as `llm.*` or `*` work as usual.
- The management token (`MGMT_TOKEN`) is accepted as the bearer. It bypasses
  the capability check, like `X-MGMT-API-KEY` on `/api/*`.
- OpenRouter's optional headers (`HTTP-Referer`, `X-Title`) are ignored.

## Endpoints

| Method | Path | |
|---|---|---|
| POST | `/api/v1/chat/completions` | Chat completion, blocking or SSE (`stream: true`) |
| GET | `/api/v1/models` | Models with an online agent that the key may use |
| GET | `/api/v1/key` | Key info. Usage is always 0, with no limit and no rate limit. |

## Model ids

Agents advertise models as capabilities, e.g. `llm.qwen3:8b[vision;tools]`.
All of these ids mean that model:

- `qwen3:8b`: what `/models` returns
- `llm.qwen3:8b`
- `offloadmq/qwen3:8b`: OpenRouter-style `vendor/model`
- `llm.qwen3:8b[vision]`: the attributes are stripped before submitting

**Aliases** let configurations written for OpenRouter keep working unchanged.
Set `OPENROUTER_MODEL_ALIASES` to a comma-separated list of `alias=model`
pairs:

```bash
OPENROUTER_MODEL_ALIASES="meta-llama/llama-3.1-8b-instruct=llama3.1:8b,openai/gpt-4o-mini=qwen3:8b"
```

An alias appears in `/models` while its target model is online.

**Fallbacks:** OpenRouter's `models: [...]` list is supported. The server
tries `model` first, then each fallback in order, and uses the first one that
has an online agent and that the key may use. The response `model` field
names the model that was actually used.

## `/models` entries

Entries follow OpenRouter's shape:

```json
{
  "id": "qwen2.5vl:7b",
  "canonical_slug": "qwen2.5vl:7b",
  "name": "OffloadMQ: qwen2.5vl:7b",
  "created": 0,
  "context_length": null,
  "architecture": {"modality": "text+image->text", "input_modalities": ["text", "image"],
                   "output_modalities": ["text"], "tokenizer": "Other", "instruct_type": null},
  "pricing": {"prompt": "0", "completion": "0", "request": "0", "image": "0"},
  "top_provider": {"context_length": null, "max_completion_tokens": null, "is_moderated": false},
  "per_request_limits": null,
  "supported_parameters": ["max_tokens", "temperature", "...", "tools", "tool_choice"]
}
```

- The `[vision]` attribute adds `image` to `input_modalities`.
- `[tools]` adds `tools` and `tool_choice` to `supported_parameters`.
- `[thinking]` or `[reasoning]` adds `reasoning`.
- `context_length` is unknown, so it is always `null`.

## Request parameters

The request is translated into an Ollama `/api/chat` payload and passed
through to the agent unchanged.

| OpenAI / OpenRouter | Ollama |
|---|---|
| `messages` | `messages`. `developer` → `system`; content-part arrays → `content` + `images`; `null` content → `""`; tool-call `arguments` strings → objects; `tool` messages get `tool_name` |
| `prompt` (no `messages`) | one `user` message |
| `temperature`, `top_p`, `top_k`, `min_p`, `seed`, `presence_penalty`, `frequency_penalty` | `options.*` |
| `repetition_penalty` | `options.repeat_penalty` |
| `max_tokens` / `max_completion_tokens` | `options.num_predict` (`max_completion_tokens` wins) |
| `stop` (string or array) | `options.stop` |
| `response_format: {type: "json_object"}` | `format: "json"` |
| `response_format: {type: "json_schema", json_schema: {schema}}` | `format: <schema>` |
| `tools` | `tools`. `tool_choice: "none"` drops them; other `tool_choice` values are ignored |
| `reasoning` / `reasoning_effort` / `include_reasoning` | `think`: `true`/`false`; an effort level for `gpt-oss` models. `reasoning.exclude: true` hides the reasoning text. |

- **Images:** only inline base64 `data:` URLs are supported in `image_url`
  parts. Remote `http(s)` image URLs get a 400.
- **Ignored on purpose:** OpenRouter routing and billing fields (`provider`,
  `transforms`, `plugins`, `route`, `user`, `usage`, `stream_options`), and
  `logit_bias`, `logprobs`, `n`. Unknown fields never cause an error.

## Responses

The response is a standard `chat.completion` object:

- **`id`:** `gen-<task id>`. The `X-OffloadMQ-Task-Id` response header carries
  the same task id, which you can use for debugging in the management UI.
- **`provider`:** `"OffloadMQ"`.
- **`message.content`:** `null` when the model only returned tool calls.
  `message.tool_calls` is in OpenAI form: `id`, `type: "function"`, and
  `function.arguments` as a JSON string.
- **`message.reasoning`:** the model's thinking text, when it produced any.
- **`finish_reason`:** `tool_calls`, `length` or `stop`. `native_finish_reason`
  is Ollama's own `done_reason`.
- **`usage`:**
  - Comes from Ollama's `prompt_eval_count` / `eval_count`, which the agent
    reports with the result.
  - If the counts are missing, `usage` is an **estimate** of about 4
    characters per token.
  - `cost` is always `0`.

### Streaming

- With `stream: true` the response is Server-Sent Events, in OpenRouter's format:
  - `chat.completion.chunk` objects;
  - `: OPENROUTER PROCESSING` comment lines every 15 s as a keep-alive;
  - a last chunk that repeats `finish_reason` and carries `usage`;
  - then `data: [DONE]`.
- Agents flush generated text about **every 2 s**, so content arrives in
  bursts rather than token by token.
- Tool calls and reasoning are sent in one chunk just before the final one.
- **Disconnects:** if the client disconnects, the task is cancelled on the
  agent. The server notices on its next send, which is at most the 15 s
  keep-alive.

## Errors

Errors use OpenRouter's envelope, which the SDKs map to their exception types:

```json
{"error": {"code": 404, "message": "No endpoints found for qwen3:8b."}}
```

| HTTP | When |
|---|---|
| 400 | Malformed body; no `messages`/`prompt`; unsupported `response_format`; remote image URL |
| 401 | Missing or invalid key |
| 403 | The key may not use the requested model(s) |
| 404 | No online agent serves the model (or any fallback) |
| 408 | No agent picked the task up in time, or the overall deadline passed |
| 499 | The task was cancelled |
| 502 | The agent failed. `message` holds the agent's error, e.g. an Ollama error. |

**Mid-stream errors:** once streaming has started, an error is sent as a final
chunk. That chunk has a top-level `error` object and
`finish_reason: "error"`, and is followed by `[DONE]`.

## Configuration

| Env var | Default | |
|---|---|---|
| `OPENROUTER_MODEL_ALIASES` | none | `alias=model,...` (see [Model ids](#model-ids)) |
| `OPENROUTER_MAX_WAIT_SECS` | `180` | How long to wait for an agent to pick up a request. Allows for Ollama cold-loading the model. |
| `OPENROUTER_TIMEOUT_SECS` | `900` | Total wall-clock limit per request. Also passed to the agent as `runtimeSecs`. |
| `OPENROUTER_MAX_BODY_BYTES` | `33554432` (32 MiB) | Request body limit; inline images make chat requests large |

## Agent requirements

- Agents must serve `llm.*` capabilities, which Ollama-backed agents register
  automatically.
- The agent forwards `options`, `format`, `tools`, `think` and `keep_alive`
  to Ollama. It returns thinking, tool calls, `done_reason` and token counts.

The standalone [`openai-api-proxy/`](../openai-api-proxy/) predates this
surface and is deprecated in its favour.
