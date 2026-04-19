# OffloadMQ LLM Integration Guide

A complete reference for integrating LLM inference (and vision/file analysis) into any application using OffloadMQ. This document is self-contained — you need nothing else to build a working client.

---

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Critical: JSON Field Naming](#critical-json-field-naming)
4. [Recommended: `llm.*` task body with `file_bucket` (vision)](#recommended-llm-task-body-with-file_bucket-vision)
5. [Task API — Blocking (Synchronous) Request](#task-api--blocking-synchronous-request)
6. [Task API — Non-Blocking (Polling) Request](#task-api--non-blocking-polling-request)
7. [Task Lifecycle and Status Values](#task-lifecycle-and-status-values)
8. [Progress Bars and Time Estimates](#progress-bars-and-time-estimates)
9. [Storage API — Uploading Files for Vision / Analysis](#storage-api--uploading-files-for-vision--analysis)
10. [End-to-End: Vision Model with File Upload](#end-to-end-vision-model-with-file-upload)
11. [Discovering Available LLM Capabilities](#discovering-available-llm-capabilities)
12. [Cancelling a Task](#cancelling-a-task)
13. [Error Reference](#error-reference)
14. [Timing and Retry Guidance](#timing-and-retry-guidance)

---

## Overview

OffloadMQ routes tasks to agent nodes by matching a **capability string**. For LLM inference the capability follows the pattern `llm.<model-name>`, for example:

- `llm.mistral`
- `llm.qwen3:8b`
- `llm.dolphin-mistral`
- `llm.llava` (vision)

Clients submit tasks carrying a JSON payload in the Ollama chat-completion format. An agent that has registered the matching capability receives the task, runs inference, and reports the result back to the server, which delivers it to the waiting client.

Two submission modes are available:

| Mode | Endpoint | When to use |
|------|----------|-------------|
| **Blocking** | `POST /api/task/submit_blocking` | Request-response flows; waits up to 60 s for the result |
| **Non-blocking** | `POST /api/task/submit` | Long-running or background inference; client polls separately |

---

## Authentication

### Task API (`/api/*`)

All task endpoints authenticate via an `apiKey` field **inside the JSON body**. There is no Authorization header for the Task API.

```json
{
  "apiKey": "your-client-api-key",
  "capability": "llm.mistral",
  "urgent": true,
  "payload": { ... }
}
```

The API key must be pre-provisioned on the server and must be permitted to use the target capability.

### Storage API (`/api/storage/*`)

The Storage API uses a **`X-API-Key` HTTP header**. There is no JSON body for most storage requests.

```
GET /api/storage/limits
X-API-Key: your-client-api-key
```

The same client API key is used for both the Task API and the Storage API.

---

## Critical: JSON Field Naming

**Task API request and response fields use camelCase, with two exceptions: `file_bucket` and `output_bucket` are snake_case.** All Storage API fields use snake_case. This inconsistency is intentional and permanent — be careful.

### Task API — mostly camelCase

Request fields: `apiKey`, `capability`, `urgent`, `restartable`, `timeoutSecs`, `payload`, `fetchFiles`, `file_bucket`, `output_bucket`

Response fields: `id`, `status`, `createdAt`, `stage`, `output`, `log`, `typicalRuntimeSeconds`, `agentId`, `assignedAt`, `createdAt`

The nested `id` object uses: `cap`, `id`

TaskStatus string values are camelCase: `pending`, `queued`, `assigned`, `starting`, `running`, `completed`, `failed`, `cancelRequested`, `canceled`, `failedRetryPending`, `failedRetryDelayed`

### Storage API — snake_case

All fields: `bucket_uid`, `file_uid`, `original_name`, `size`, `sha256`, `used_bytes`, `remaining_bytes`, `capacity_bytes`, `file_count`, `created_at`, `uploaded_at`, `rm_after_task`, `max_buckets_per_key`, `bucket_size_bytes`, `bucket_ttl_minutes`

### Summary table

| Context | Field examples | Format |
|---------|---------------|--------|
| Task submission — general | `apiKey`, `fetchFiles` | camelCase |
| Task submission — bucket refs | `file_bucket`, `output_bucket` | **snake_case** |
| Task status response | `createdAt`, `typicalRuntimeSeconds` | camelCase |
| Storage API requests/responses | `bucket_uid`, `file_uid` | snake_case |

---

## Recommended: `llm.*` task body with `file_bucket` (vision)

External clients (and the **management frontend** sandbox) should treat the following as the **stable contract** for vision and file-backed `llm.*` tasks. Reference implementation: `management-frontend/src/components/ImageAnalyzerApp.jsx` (create bucket, upload multipart field `file`, submit with `file_bucket`, empty `fetchFiles` / `artifacts`, chat-style `payload`).

### Always send `fetchFiles` and `artifacts` when unused

Set both to empty JSON arrays **`[]`** on every submit if you are not using HTTP fetch rules or artifact output definitions. The sandbox apps always include these keys so parsers and integrations see a consistent shape.

### Prefer chat `payload` without a top-level `model` for vision

For Ollama chat-style tasks, the offload agent (`offload-agent/app/exec/llm.py`) builds the REST body as follows: it merges your `payload`, attaches base64 images from files downloaded from **`file_bucket`**, then sets **`model`** from the task **`capability`** string (the part after `llm.`, before any `[` bracket).

**Recommended:** put only **`stream`** (usually `false`) and **`messages`** in `payload`, and **omit** a top-level **`model`** key. That matches the Image Analyzer sandbox and avoids duplicating or drifting from the agent's model selection.

**Still valid:** older clients may include **`model`** inside `payload` for text-only flows; the agent overwrites `model` from `capability` at send time. For vision with `file_bucket`, omitting `payload.model` is the path that matches the known-good sandbox.

### Name the file in user text when it helps

After upload, the server stores `original_name` (from multipart filename). The agent saves downloads under that path and scans for image extensions. Referencing that name in the user `content` string (for example `diagram.png`) keeps logs and model instructions aligned with the bucket listing.

---

## Task API — Blocking (Synchronous) Request

Use this mode when you need the result inline, like a standard HTTP request-response. The server holds the HTTP connection open until the agent completes the task or 60 seconds elapse.

### Endpoint

```
POST /api/task/submit_blocking
Content-Type: application/json
```

### Request Body

```json
{
  "apiKey": "your-client-api-key",
  "capability": "llm.dolphin-mistral",
  "urgent": true,
  "restartable": false,
  "payload": {
    "stream": false,
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "Summarize the theory of relativity in two sentences."
      }
    ]
  },
  "fetchFiles": [],
  "file_bucket": [],
  "artifacts": []
}
```

**Required fields:**

| Field | Type | Notes |
|-------|------|-------|
| `apiKey` | string | Your client API key |
| `capability` | string | Base capability, no brackets (e.g. `"llm.mistral"`) |
| `urgent` | boolean | **Must be `true`** for this endpoint |
| `payload` | object | Task data — passed unchanged to the agent |

**Optional fields:**

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `restartable` | boolean | `false` | Allow retry on a different agent if this one fails |
| `timeoutSecs` | integer | `600` | Maximum seconds the agent may spend on this task. For LLM tasks this is the HTTP request timeout to Ollama — set higher for large models or long prompts. |
| `fetchFiles` | object[] | `[]` | Send `[]` when unused (recommended for all clients; see [Recommended: `llm.*` task body with `file_bucket` (vision)](#recommended-llm-task-body-with-file_bucket-vision)) |
| `file_bucket` | string[] | `[]` | Bucket UIDs containing input files (see Storage API) |
| `artifacts` | object[] | `[]` | Send `[]` when unused (recommended alongside `fetchFiles`) |
| `output_bucket` | string | `null` | Bucket UID for agent to upload output files into |
| `dataPreparation` | object | `{}` | Map of glob mask → action applied to downloaded input files before the agent runs inference. Useful for vision tasks to normalise image size. Key: glob pattern (`"*"`, `"*.jpg"`). Value: `"scale/WxH"` (resize, e.g. `"scale/1024x1024"`) or `"transcode/FORMAT[key=val;…]"` (convert format, e.g. `"transcode/jpeg[quality=85]"`). Applied after all bucket and fetch-file downloads complete. |

### Payload Format (LLM)

The payload is passed to the agent. Agents normalize it toward the Ollama chat API. **Recommended** chat shape (matches the management Image Analyzer sandbox):

```json
{
  "stream": false,
  "messages": [
    { "role": "system", "content": "System prompt here." },
    { "role": "user",   "content": "User message here." }
  ]
}
```

The server routes tasks using the top-level **`capability`** string. The Python offload agent sets **`model`** on the Ollama request from that capability (see [Recommended: `llm.*` task body with `file_bucket` (vision)](#recommended-llm-task-body-with-file_bucket-vision)). You may still include **`model`** inside `payload` for legacy text-only clients; it is overwritten for the actual Ollama call.

### Successful Response (HTTP 200)

The response is the full assigned task record serialized with camelCase:

```json
{
  "id": {
    "cap": "llm.dolphin-mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "data": {
    "capability": "llm.dolphin-mistral",
    "urgent": true,
    "restartable": false,
    "payload": { ... },
    "fetchFiles": [],
    "file_bucket": [],
    "output_bucket": null,
    "artifacts": [],
    "apiKey": "your-client-api-key"
  },
  "agentId": "01ARZ3NDE4V2XTGZUVAB",
  "status": "completed",
  "history": [
    { "timestamp": "2026-04-08T12:00:01Z", "description": "Assigned to 01ARZ..." },
    { "timestamp": "2026-04-08T12:00:12Z", "description": "Status set to Completed" }
  ],
  "createdAt": "2026-04-08T12:00:00Z",
  "assignedAt": "2026-04-08T12:00:01Z",
  "result": {
    "response": "According to Ollama/LLM output...",
    "done": true,
    "total_duration": 5234000000
  },
  "log": "Model loaded in 1.2s\nInference started\nDone in 4.0s\n",
  "stage": null,
  "typicalRuntimeSeconds": { "secs": 8, "nanos": 0 }
}
```

**Key response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id.cap` | string | Capability (queue) used |
| `id.id` | string | Unique task identifier |
| `status` | string | `"completed"` or `"failed"` |
| `result` | object\|null | The LLM output object; structure depends on agent implementation |
| `log` | string\|null | Accumulated agent log lines (for debugging) |
| `stage` | string\|null | Last reported execution stage |
| `typicalRuntimeSeconds` | `{secs,nanos}`\|null | Historical average duration; null if no history |

### Failed Response (HTTP 200 with `status: "failed"`)

A task can complete without error from the server but report failure from the agent. HTTP status is still 200; check the `status` field:

```json
{
  "id": { "cap": "llm.mistral", "id": "01ARZ3NDE4V2XTGZUVY7" },
  "status": "failed",
  "result": {
    "error": "model 'mistral' not found"
  },
  "log": "Attempting to load model...\nError: model not found\n",
  "stage": null
}
```

### Timeout Response (HTTP 408 or 503)

If no agent is available immediately: `503 Service Unavailable`

```json
{
  "error": {
    "type": "scheduling impossible",
    "message": "Scheduling impossible: no online runners for capability llm.mistral",
    "status": 503
  }
}
```

If an agent picked up the task but didn't complete it within 60 seconds, the HTTP connection returns a timeout error. The task continues running on the server. You can then poll it using `POST /api/task/poll/{cap}/{id}` (see Non-Blocking section).

---

## Task API — Non-Blocking (Polling) Request

Use this for tasks that may take longer than 60 seconds, or when you want to track progress with a UI.

### Step 1 — Submit

```
POST /api/task/submit
Content-Type: application/json
```

**Request body** is identical to the blocking endpoint, except `urgent` can be `true` or `false`:

- `urgent: true` — stored in memory, 60s TTL, higher priority
- `urgent: false` — persisted to database, survives restarts, no TTL

```json
{
  "apiKey": "your-client-api-key",
  "capability": "llm.qwen3:8b",
  "urgent": false,
  "restartable": false,
  "payload": {
    "stream": false,
    "messages": [
      { "role": "user", "content": "Write a poem about the ocean." }
    ]
  },
  "fetchFiles": [],
  "file_bucket": [],
  "artifacts": []
}
```

**Response (HTTP 200):**

```json
{
  "id": {
    "cap": "llm.qwen3:8b",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "capability": "llm.qwen3:8b",
  "status": "queued",
  "message": "Added to tasks queue"
}
```

Save `id.cap` and `id.id` — you need both to poll.

### Step 2 — Poll

```
POST /api/task/poll/{cap}/{id}
Content-Type: application/json
```

The capability value must be URL-encoded if it contains special characters (colons, dots are safe in most HTTP clients, but encode to be safe: `llm.qwen3%3A8b`).

**Request body:**

```json
{
  "apiKey": "your-client-api-key"
}
```

**Response (HTTP 200):**

```json
{
  "id": {
    "cap": "llm.qwen3:8b",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "status": "running",
  "createdAt": "2026-04-08T12:00:00Z",
  "stage": "inference",
  "output": null,
  "log": "Model qwen3:8b loaded in 3.1s\nStarting inference...\n",
  "typicalRuntimeSeconds": { "secs": 15, "nanos": 0 }
}
```

When complete:

```json
{
  "id": {
    "cap": "llm.qwen3:8b",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "status": "completed",
  "createdAt": "2026-04-08T12:00:00Z",
  "stage": null,
  "output": {
    "response": "The ocean breathes in waves of silver light...",
    "done": true
  },
  "log": "Model loaded in 3.1s\nInference done in 12.4s\n",
  "typicalRuntimeSeconds": { "secs": 15, "nanos": 0 }
}
```

**Poll response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | object | `{cap, id}` task identifier |
| `status` | string | Current status (see Task Lifecycle) |
| `createdAt` | string | ISO 8601 UTC timestamp — always present |
| `stage` | string\|null | Current execution stage set by the agent, e.g. `"inference"`, `"loading"` |
| `output` | object\|null | Result data — present only when `status` is `completed` or `failed` |
| `log` | string\|null | Accumulated log lines from the agent, appended over time |
| `typicalRuntimeSeconds` | `{secs,nanos}`\|null | Historical median duration; `null` until 2+ completions exist |

### Recommended Polling Intervals

| Task phase | Suggested interval |
|------------|--------------------|
| Waiting for assignment (`queued`, `pending`) | 2–3 seconds |
| Assigned or starting | 1–2 seconds |
| Running | 2–5 seconds |
| After `typicalRuntimeSeconds` is known | Poll at 80% of estimate, then every 2s |

Stop polling when `status` is `completed`, `failed`, or `canceled`.

---

## Task Lifecycle and Status Values

Tasks move through these states. Not all states appear for every task.

```
submitted → pending → queued → [pinned] → assigned → starting → running → completed
                                                                         ↘ failed
                                                                         ↘ cancelRequested → canceled
                                                                         ↘ failedRetryPending → failedRetryDelayed → queued (retry)
```

| Status | Meaning | `output` present? |
|--------|---------|-------------------|
| `pending` | Accepted, not yet queued | No |
| `queued` | Waiting for an available agent | No |
| `pinned` | Reserved for a specific agent, not yet claimed | No |
| `assigned` | Agent claimed the task | No |
| `starting` | Agent is loading the model / preparing | No |
| `running` | Inference in progress | No |
| `completed` | Task succeeded | Yes |
| `failed` | Task failed | Yes (contains error info) |
| `cancelRequested` | Client requested cancellation | No |
| `canceled` | Task cancelled by client | No |
| `failedRetryPending` | Failed, scheduled for retry | No |
| `failedRetryDelayed` | Failed, waiting before retry | No |

**Terminal states** (stop polling): `completed`, `failed`, `canceled`

---

## Progress Bars and Time Estimates

The `typicalRuntimeSeconds` field contains the server's historical estimate for how long this capability typically takes on the agent that claimed the task. It is available as soon as the agent picks up the task (i.e. status transitions from `queued` to `assigned` or later).

Format: `{ "secs": 15, "nanos": 0 }` — convert to milliseconds as `secs * 1000 + nanos / 1_000_000`.

It is `null` when no historical data exists (first few runs of a capability).

### Progress bar algorithm

```javascript
let startTime = null;
let estimatedMs = null;

function onPollResponse(response) {
  // Initialize timing on first non-queued response
  if (!startTime && ['assigned','starting','running'].includes(response.status)) {
    startTime = Date.now();
  }

  // Extract estimate when it becomes available
  if (response.typicalRuntimeSeconds && !estimatedMs) {
    const t = response.typicalRuntimeSeconds;
    estimatedMs = t.secs * 1000 + t.nanos / 1_000_000;
  }

  if (response.status === 'completed') return { progress: 1.0 };
  if (response.status === 'failed')    return { progress: 1.0 };

  // Calculate progress from elapsed time vs estimate
  if (startTime && estimatedMs) {
    const elapsed = Date.now() - startTime;
    // Cap at 0.95 until we get the actual completion signal
    return { progress: Math.min(0.95, elapsed / estimatedMs) };
  }

  // No estimate yet — show indeterminate or a small fixed value
  return { progress: null };
}
```

The `stage` field provides a human-readable label to display alongside the progress bar (e.g. "Loading model", "Running inference", "Post-processing").

The `log` field accumulates all agent log lines. It grows over time — diff against the last-seen log string to extract new lines for a streaming log view.

---

## Storage API — Uploading Files for Vision / Analysis

For vision models or document analysis you need to upload files before submitting the task, then pass the bucket UID to the agent via the task's `file_bucket` field.

### Auth header

All storage endpoints use `X-API-Key` header with your client API key. No JSON body for GET/DELETE.

### Default limits

| Limit | Default |
|-------|---------|
| Max buckets per API key | 256 |
| Max bytes per bucket | 1 GiB |
| Bucket TTL | 24 hours (auto-deleted) |

Query your actual limits:

```
GET /api/storage/limits
X-API-Key: your-client-api-key
```

Response (snake_case):

```json
{
  "max_buckets_per_key": 256,
  "bucket_size_bytes": 1073741824,
  "bucket_ttl_minutes": 1440
}
```

### Create a bucket

```
POST /api/storage/bucket/create
X-API-Key: your-client-api-key
```

No request body required. Optional query parameter: `?rm_after_task=true` to automatically delete the bucket after its first associated task completes.

**Response (HTTP 201, snake_case):**

```json
{
  "bucket_uid": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-04-08T12:00:00Z",
  "rm_after_task": false
}
```

Save `bucket_uid` — you need it for upload and task submission.

### Upload a file

```
POST /api/storage/bucket/{bucket_uid}/upload
X-API-Key: your-client-api-key
Content-Type: multipart/form-data
```

The multipart field must be named `file`. Include a filename in the Content-Disposition.

**cURL example:**

```bash
curl -X POST https://mq.example.com/api/storage/bucket/550e8400.../upload \
  -H "X-API-Key: your-client-api-key" \
  -F "file=@/path/to/image.jpg"
```

**Python example:**

```python
import requests

with open("image.jpg", "rb") as f:
    response = requests.post(
        f"https://mq.example.com/api/storage/bucket/{bucket_uid}/upload",
        headers={"X-API-Key": api_key},
        files={"file": ("image.jpg", f, "image/jpeg")}
    )
```

**Response (HTTP 201, snake_case):**

```json
{
  "file_uid": "a3bb189e-8bf9-3888-9912-ace4e6543002",
  "original_name": "image.jpg",
  "size": 204800,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

Save `file_uid` if you need to reference a specific file later; the agent receives the full bucket and can list its files.

**Filename path rules:**
- Absolute paths (`/home/user/img.jpg`, `C:\Users\...`) are stripped to base filename only
- Relative paths (`data/images/photo.jpg`) are preserved including subdirectory structure
- `..` components are removed for security

### Inspect a bucket

```
GET /api/storage/bucket/{bucket_uid}/stat
X-API-Key: your-client-api-key
```

**Response (HTTP 200, snake_case):**

```json
{
  "bucket_uid": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-04-08T12:00:00Z",
  "used_bytes": 204800,
  "capacity_bytes": 1073741824,
  "remaining_bytes": 1073536024,
  "file_count": 1,
  "rm_after_task": false,
  "files": [
    {
      "file_uid": "a3bb189e-8bf9-3888-9912-ace4e6543002",
      "original_name": "image.jpg",
      "size": 204800,
      "uploaded_at": "2026-04-08T12:00:05Z"
    }
  ]
}
```

### Download a file

```
GET /api/storage/bucket/{bucket_uid}/file/{file_uid}
X-API-Key: your-client-api-key
```

Returns raw file bytes with `Content-Disposition: attachment; filename="original_name"`. This is how clients retrieve files that an agent has uploaded to an `output_bucket`.

### Delete a file

```
DELETE /api/storage/bucket/{bucket_uid}/file/{file_uid}
X-API-Key: your-client-api-key
```

**Response (HTTP 200):**

```json
{ "deleted_file_uid": "a3bb189e-8bf9-3888-9912-ace4e6543002" }
```

### Delete a bucket

```
DELETE /api/storage/bucket/{bucket_uid}
X-API-Key: your-client-api-key
```

Deletes the bucket and all its files.

**Response (HTTP 200):**

```json
{ "deleted_bucket_uid": "550e8400-e29b-41d4-a716-446655440000" }
```

### List all buckets

```
GET /api/storage/buckets
X-API-Key: your-client-api-key
```

**Response (HTTP 200):**

```json
{
  "buckets": [
    {
      "bucket_uid": "550e8400-e29b-41d4-a716-446655440000",
      "created_at": "2026-04-08T12:00:00Z",
      "file_count": 1,
      "used_bytes": 204800,
      "remaining_bytes": 1073536024,
      "tasks": ["llm.llava[01ARZ3NDE4V2XTGZUVY7]"],
      "rm_after_task": false
    }
  ]
}
```

### Get file SHA-256

```
GET /api/storage/bucket/{bucket_uid}/file/{file_uid}/hash
X-API-Key: your-client-api-key
```

**Response (HTTP 200):**

```json
{
  "file_uid": "a3bb189e-8bf9-3888-9912-ace4e6543002",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb924..."
}
```

---

## End-to-End: Vision Model with File Upload

This example walks through uploading an image and running it through a vision LLM.

### Step 1 — Create a bucket

```bash
curl -X POST https://mq.example.com/api/storage/bucket/create \
  -H "X-API-Key: client_secret_key_123"
```

```json
{ "bucket_uid": "550e8400-...", "created_at": "...", "rm_after_task": false }
```

### Step 2 — Upload the image

```bash
curl -X POST https://mq.example.com/api/storage/bucket/550e8400-.../upload \
  -H "X-API-Key: client_secret_key_123" \
  -F "file=@diagram.png"
```

```json
{ "file_uid": "a3bb189e-...", "original_name": "diagram.png", "size": 102400, "sha256": "..." }
```

### Step 3 — Submit the LLM vision task (blocking)

```bash
curl -X POST https://mq.example.com/api/task/submit_blocking \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "client_secret_key_123",
    "capability": "llm.llava",
    "urgent": true,
    "restartable": false,
    "fetchFiles": [],
    "file_bucket": ["550e8400-e29b-41d4-a716-446655440000"],
    "artifacts": [],
    "payload": {
      "stream": false,
      "messages": [
        {
          "role": "user",
          "content": "Describe what you see in diagram.png in detail."
        }
      ]
    }
  }'
```

The agent receives the task with the bucket UIDs. It downloads files from the bucket using its private agent API, then runs vision inference referencing the downloaded file by its `original_name`.

### Step 4 — Read the result

```json
{
  "id": { "cap": "llm.llava", "id": "01ARZ..." },
  "status": "completed",
  "result": {
    "response": "The diagram shows a flowchart with three main components...",
    "done": true
  },
  "log": "Downloading diagram.png from bucket 550e8400...\nRunning vision inference...\nDone.\n"
}
```

### Step 5 — Clean up the bucket

```bash
curl -X DELETE https://mq.example.com/api/storage/bucket/550e8400-... \
  -H "X-API-Key: client_secret_key_123"
```

**Tip:** Use `?rm_after_task=true` when creating the bucket to skip this step — the server automatically deletes it once the task completes.

---

## Discovering Available LLM Capabilities

To find which LLM capabilities are currently online (i.e. have at least one agent ready):

```
POST /api/capabilities/online
Content-Type: application/json
```

```json
{ "apiKey": "your-client-api-key" }
```

**Response (HTTP 200):**

```json
["llm.mistral", "llm.qwen3:8b", "llm.llava", "shell.bash"]
```

The response is a flat array of base capability strings (no brackets). Filter by prefix `"llm."` to find LLM-capable agents. Only capabilities permitted by your API key are returned.

### Extended capability strings (optional)

If you need bracket metadata from agents (model tags, `vision`, tool hints, etc.) while still using a **client API key**, use:

```
POST /api/capabilities/list/online_ext
Content-Type: application/json
```

```json
{ "apiKey": "your-client-api-key" }
```

The response is a JSON array of **raw** capability strings (extended attributes preserved). Entries are limited to capabilities your key is allowed to use (matching is on the base capability, i.e. the part before `[`). For the full fleet with no per-key filter, use the management endpoint `GET /management/capabilities/list/online_ext` with a Bearer management token, or pass `X-MGMT-API-KEY` on this Client API route (see [tasks-api.md](tasks-api.md#get-online-capabilities-extended-client-filtered)).

---

## Cancelling a Task

```
POST /api/task/cancel/{cap}/{id}
Content-Type: application/json
```

```json
{ "apiKey": "your-client-api-key" }
```

**Response (HTTP 200) — if task was assigned to an agent:**

```json
{
  "id": { "cap": "llm.mistral", "id": "01ARZ..." },
  "status": "cancelRequested",
  "message": "Cancellation requested"
}
```

**Response (HTTP 200) — if task was still queued:**

```json
{
  "id": { "cap": "llm.mistral", "id": "01ARZ..." },
  "status": "canceled",
  "message": "Task cancelled (was queued)"
}
```

For already-assigned tasks, the agent receives a signal on its next progress update. The task transitions to `canceled` once the agent acknowledges. Keep polling to confirm.

**Error (HTTP 409) — task already in terminal state:**

```json
{
  "error": {
    "type": "conflict",
    "message": "Conflict: Task ... is already in terminal state Completed",
    "status": 409
  }
}
```

---

## Error Reference

All errors use the same JSON envelope:

```json
{
  "error": {
    "type": "error_type_string",
    "message": "Human-readable description of the problem",
    "status": 404
  }
}
```

### HTTP status codes

| HTTP | `type` | Cause |
|------|--------|-------|
| 400 | `bad_request` | Missing required field, `urgent` not true on blocking endpoint, malformed JSON |
| 400 | `parse_error` | URL path parameter could not be parsed |
| 400 | `validation_error` | Field value failed validation |
| 401 | `authentication_error` | API key not found or not active |
| 403 | `authorization_error` | API key exists but lacks permission for this capability, or bucket owned by a different key |
| 404 | `not_found` | Task ID not found, bucket not found, file not found |
| 409 | `conflict` | Bucket limit reached, task already in terminal state, `rm_after_task` bucket already used |
| 500 | `internal_error` | Unexpected server error |
| 500 | `database_error` | Storage backend error |
| 503 | `scheduling impossible` | No online agents registered for this capability |

### Common LLM integration errors

**No agent available:**
```json
{
  "error": {
    "type": "scheduling impossible",
    "message": "Scheduling impossible: no online runners for capability llm.mistral",
    "status": 503
  }
}
```
Wait and retry, or check if the agent node is running.

**Wrong API key:**
```json
{
  "error": {
    "type": "authentication_error",
    "message": "Authentication failed: API key not found",
    "status": 401
  }
}
```

**Key not permitted for this capability:**
```json
{
  "error": {
    "type": "authentication_error",
    "message": "Authentication failed: ...",
    "status": 401
  }
}
```

**Bucket belongs to a different key:**
```json
{
  "error": {
    "type": "authorization_error",
    "message": "Authorization failed: Bucket 550e... is not owned by the provided API key",
    "status": 403
  }
}
```

**`urgent` field missing on blocking endpoint:**
```json
{
  "error": {
    "type": "bad_request",
    "message": "Bad request: Only urgent tasks can be submitted to this endpoint",
    "status": 400
  }
}
```

---

## Timing and Retry Guidance

### Blocking requests

- Maximum wait time: **60 seconds**
- If no agent picks up the task within 60 s, the server returns an error and the task is purged from the urgent queue
- `503` before the connection is established means no agent is online right now; retry after a delay
- Actual LLM inference on a GPU typically completes in 3–30 seconds for common models
- For models requiring more than 60 s (long context, slow hardware), use the non-blocking path instead

### Non-blocking requests (persistent, `urgent: false`)

- No TTL — tasks survive server restarts and queue indefinitely
- Typical agent polling frequency: every 5–10 seconds
- After submission, expect an `assigned` or `starting` status within 5–15 seconds if an agent is available
- Poll more aggressively (every 1–2 s) after `starting`, then ease to 2–5 s during `running`
- Check `typicalRuntimeSeconds` at `assigned` state to set a timeout expectation

### Non-blocking requests (urgent, `urgent: true` submitted to `/submit`)

- 60 second TTL in-memory
- Poll the returned task ID; if you receive a 404 before completion, the task expired
- Use persistent (`urgent: false`) if there is any risk of the agent being busy for more than 60 s

### Suggested retry strategy for 503 errors

```python
import time

def submit_with_retry(payload, max_retries=5, base_delay=3):
    for attempt in range(max_retries):
        response = requests.post(url, json=payload, timeout=65)
        if response.status_code == 503:
            delay = base_delay * (2 ** attempt)  # exponential backoff
            time.sleep(delay)
            continue
        return response
    raise RuntimeError("No agent available after retries")
```
