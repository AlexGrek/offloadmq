# Tasks API

Complete documentation for task submission, polling, and execution across both client and agent APIs.

---

## Table of Contents

1. [Overview](#overview)
2. [Client API](#client-api) — Submit, monitor tasks, discover capabilities
3. [Agent API](#agent-api) — Receive, execute, and report tasks
4. [Task Lifecycle](#task-lifecycle) — States and transitions
5. [Status Codes](#status-codes) — Error handling
6. [Examples](#examples)

---

## Overview

Tasks flow through a client-server-agent pipeline:

1. **Client submits** a task via `POST /api/task/submit` or `POST /api/task/submit_blocking`
2. **Server queues** the task (urgent in-memory or persistent DB)
3. **Agent polls** for tasks via `GET /private/agent/task/poll` or `GET /private/agent/task/poll_urgent`
4. **Agent claims** the task via `POST /private/agent/take/{cap}/{id}`
5. **Agent executes** and reports progress via `POST /private/agent/task/progress/{cap}/{id}`
6. **Agent resolves** the task via `POST /private/agent/task/resolve/{cap}/{id}`
7. **Client polls** task status via `POST /api/task/poll/{cap}/{id}` to get results

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Capability** | A string like `"llm.mistral"` or `"vision[gpu;cuda12.1]"` identifying what a task requires or an agent provides. Agents can register with extended attributes in brackets; clients submit tasks with base capability only. |
| **Task ID** | Composed of capability (queue) and a time-sortable unique ID: `TaskId { cap: "llm.mistral", id: "01ARZ3NDE..." }` |
| **Urgent** | Tasks with `urgent: true` are stored in-memory with 60s TTL and return immediate blocking (for `/submit_blocking`). Regular tasks persist to Sled DB with 24h+ lifetime. |
| **Tier** | Agent performance tier (0-255). Higher-tier agents get priority for non-urgent tasks. Lower-tier agents still receive tasks when no higher-tier agents are online. |
| **Input Buckets** (`fileBucket`) | Optional list of storage bucket UIDs where the agent can download input files. Agents learn these UIDs from the task data; the unguessable UUIDs act as capability tokens. |
| **Output Bucket** (`outputBucket`) | Optional single bucket UID where the agent should upload output files (e.g., generated images). The client creates this bucket before submitting the task and downloads results from it afterwards via `GET /api/storage/bucket/{uid}/file/{file_uid}`. |

---

## Client API

Base path: `/api/*`
Authentication: `apiKey` field in JSON body

### Submit Task (Non-Blocking)

```
POST /api/task/submit
Content-Type: application/json
```

Submits a task to the queue. Returns immediately with task ID. Can be urgent or regular (persistent).

**Request body**

```json
{
  "apiKey": "your-client-api-key",
  "capability": "llm.mistral",
  "payload": {
    "prompt": "What is 2+2?",
    "model": "mistral-7b"
  },
  "urgent": false,
  "restartable": true,
  "fileBucket": ["bucket-uid-1", "bucket-uid-2"],
  "outputBucket": "output-bucket-uid",
  "fetchFiles": [],
  "artifacts": []
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | string | Yes | Your client API key |
| `capability` | string | Yes | Base capability required (e.g., `"llm.mistral"`, `"vision"`) — extended attributes are stripped on matching |
| `payload` | object | Yes | Task-specific data (any valid JSON) — passed to agent as-is |
| `urgent` | boolean | No (default: false) | If true, stored in-memory with 60s TTL; if false, persisted to DB |
| `restartable` | boolean | No (default: false) | If true, task can be retried on another agent if it fails |
| `fileBucket` | string[] | No | List of bucket UIDs containing input files. Agents can download from these buckets. |
| `outputBucket` | string | No | UID of a bucket the agent should upload output files into. The client must create this bucket beforehand and own it. When provided, the agent uploads output files (e.g., images, video) directly to the bucket instead of embedding them as base64 in the task output. The client can then download them via `GET /api/storage/bucket/{uid}/file/{file_uid}`. |
| `fetchFiles` | object[] | No | Advanced: HTTP fetch rules (see Advanced below) |
| `artifacts` | object[] | No | Advanced: Output artifact definitions (see Advanced below) |

**Response** (202 Accepted for urgent, 201 Created for regular)

Urgent task response:
```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "capability": "llm.mistral",
  "status": "pending",
  "message": "Task submitted to urgent queue, waiting for agent"
}
```

Regular task response:
```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "capability": "llm.mistral",
  "status": "pending",
  "message": "Added to tasks queue"
}
```

| Field | Description |
|-------|-------------|
| `id` | Task identifier (capability + unique ID) |
| `status` | Always "pending" at submission |
| `message` | Human-readable status description |

**Error responses**

| Status | Reason |
|--------|--------|
| `400` | Invalid capability, missing apiKey, or malformed payload |
| `401` | API key not found or lacks capability |
| `403` | Bucket not found or not owned by API key |
| `500` | Server error queuing task |

**Notes**

- Urgent tasks block agents' polling for up to 60 seconds, then auto-expire
- Regular tasks persist in Sled DB indefinitely until completed/failed/archived
- File buckets can only be used if they exist and are owned by your API key
- Servers validate bucket ownership on submission

---

### Submit Task (Blocking)

```
POST /api/task/submit_blocking
Content-Type: application/json
```

Submits an urgent task and **blocks the HTTP connection waiting for the result**. Used for synchronous, latency-sensitive operations.

**Request body**

Same as `/api/task/submit`, but `urgent` field is **required** to be `true`.

**Response** (200 OK on completion)

```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "status": "completed",
  "output": {
    "result": "2 + 2 equals 4"
  },
  "log": null
}
```

Or on failure:
```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "status": "failed",
  "output": {
    "error": "Model not found"
  },
  "log": "Error loading model: ..."
}
```

**Behavior**

- HTTP connection remains open until task completes or 60s timeout (whichever comes first)
- Server uses internal `tokio::sync::watch` channel to notify waiting client
- If task completes before timeout, client gets result immediately
- If timeout expires, task continues executing but client receives timeout error
- Useful for request-response patterns (LLM inference, OCR, etc.)

**Error responses**

| Status | Reason |
|--------|--------|
| `400` | `urgent` field is not true, or other validation error |
| `401` | API key not found or lacks capability |
| `408` | Timeout waiting for agent (task still running on server) |
| `500` | Server error |

---

### Poll Task Status

```
POST /api/task/poll/{cap}/{id}
Content-Type: application/json
```

Checks the status of a task by ID. Works for both urgent and regular tasks.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `cap` | string | The capability (queue) — URL-encoded if contains special chars |
| `id` | string | The time-sortable task ID |

**Request body**

```json
{
  "apiKey": "your-client-api-key"
}
```

**Response** (200 OK)

Pending task:
```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "status": "queued",
  "stage": null,
  "output": null,
  "log": null
}
```

Running task:
```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "status": "running",
  "stage": "inference",
  "output": null,
  "log": "Loading model from /models/mistral-7b...\nModel loaded in 2.5s\nProcessing prompt...\n"
}
```

Completed task:
```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "status": "completed",
  "stage": null,
  "output": {
    "result": "2 + 2 = 4",
    "tokens_used": 15,
    "inference_time_ms": 245
  },
  "log": "Model loaded in 2.5s\nInference took 245ms\n"
}
```

Failed task:
```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "status": "failed",
  "stage": null,
  "output": {
    "error": "Out of memory",
    "error_code": "OOM"
  },
  "log": "Loading model...\nModel loaded in 2.5s\nAllocating 8GB for inference...\nError: insufficient memory\n"
}
```

| Field | Description |
|-------|-------------|
| `id` | Task identifier |
| `status` | Current task status (see Task Lifecycle below) |
| `stage` | Optional human-readable current stage (e.g., "inference", "post-processing") |
| `output` | Task result object (only present if completed or failed) |
| `log` | Accumulated agent logs (only if agent sent updates) |

**Task Status Values**

| Status | Meaning |
|--------|---------|
| `pending` | Accepted but not yet queued |
| `queued` | Waiting for an available agent |
| `pinned` | Reserved for a specific agent but not yet picked up |
| `assigned` | Agent has claimed the task |
| `starting` | Agent is preparing the task (loading models, etc.) |
| `running` | Task is actively executing |
| `completed` | Task succeeded, result in `output` |
| `failed` | Task failed, error in `output` |
| `failedRetryPending` | Failed but scheduled for retry |
| `failedRetryDelayed` | Failed and waiting before retry |
| `canceled` | Task was cancelled by client |

**Error responses**

| Status | Reason |
|--------|--------|
| `401` | API key not found or missing |
| `404` | Task not found (may have been archived) |
| `500` | Server error retrieving task |

**Notes**

- Task ownership is enforced: clients can only poll tasks they submitted (apiKey matches)
- Polling is non-blocking and can be called repeatedly
- Log accumulates as agent sends progress updates
- Completed/failed tasks are archived after 7 days (configurable)
- Polling a deleted/archived task returns 404

---

### Get Online Capabilities (Client-Filtered)

```
POST /api/capabilities/online
Content-Type: application/json
```

Returns the set of base capabilities currently provided by online agents, **filtered to only those the calling API key is authorized to use**. Useful for clients to discover what they can submit without trial-and-error.

**Request body**

```json
{
  "apiKey": "your-client-api-key"
}
```

**Response** (200 OK)

```json
["llm.mistral", "vision"]
```

The response is a JSON array of base capability strings (extended attributes stripped). Only capabilities that satisfy **both** conditions are included:
- At least one online agent advertises the capability
- The API key has that capability in its allowed list

**Error responses**

| Status | Reason |
|--------|--------|
| `401` | API key not found or revoked |
| `500` | Server error |

**Notes**

- Extended attributes are stripped — `"llm.mistral[7b;fp16]"` appears as `"llm.mistral"`
- Online threshold: agent must have contacted the server within the last 120 seconds
- Result is a deduplicated set (unordered)
- Complements the management endpoint `GET /management/capabilities/list/online`, which returns all online capabilities regardless of key permissions

---

## Agent API

Base path: `/private/agent/*`
Authentication: `Authorization: Bearer <JWT>` header

### Register Agent

```
POST /private/agent/register
Content-Type: application/json
```

Register a new agent with the system. Returns agent ID and login credentials.

**Request body**

```json
{
  "capabilities": ["llm.mistral", "vision[gpu;cuda12.1]"],
  "tier": 5,
  "capacity": 4,
  "apiKey": "agent-registration-key",
  "displayName": "Apple M3 Pro 16GB",
  "systemInfo": {
    "os": "Linux",
    "client": "offload-agent/0.1.0",
    "runtime": "Python 3.11",
    "cpuArch": "aarch64",
    "totalMemoryGb": 32,
    "gpu": {
      "vendor": "NVIDIA",
      "model": "RTX 4090",
      "vramGb": 24
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `capabilities` | string[] | List of capabilities with optional extended attributes in brackets (e.g., `"llm.qwen3:8b[vision;tools;8b]"`) |
| `tier` | integer (0-255) | Performance tier. Higher = better. Used for task scheduling priority. |
| `capacity` | integer | Max concurrent tasks this agent can handle |
| `apiKey` | string | Agent registration key (from server config) |
| `displayName` | string (optional) | Human-readable name shown in the management UI (max 50 chars). Auto-computed from system specs if omitted. Returns 400 if longer than 50 characters. |
| `systemInfo` | object | System details (OS, memory, GPU, etc.) |
| `systemInfo.totalMemoryGb` | integer | Total system RAM in whole gigabytes |
| `systemInfo.gpu` | object | Optional GPU info if available |
| `systemInfo.gpu.vramGb` | integer | GPU VRAM in whole gigabytes (0 if unknown) |

**Response** (201 Created)

```json
{
  "agentId": "agent-abc123def456",
  "key": "my-secret-login-token-12345",
  "message": "Registered"
}
```

**Notes**

- Save the `agentId` and `key` — you'll need them to authenticate
- Register only once; to update capabilities/tier, use `/private/agent/update`

---

### Agent Login

```
POST /private/agent/login
Content-Type: application/json
```

Authenticate and receive a JWT token for subsequent requests.

**Request body**

```json
{
  "agentId": "agent-abc123def456",
  "key": "my-secret-login-token-12345"
}
```

**Response** (200 OK)

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600
}
```

| Field | Description |
|-------|-------------|
| `token` | JWT token for `Authorization: Bearer` header |
| `expiresIn` | Token validity in seconds |

**Notes**

- Token is valid for 1 hour (configurable)
- Use token in all subsequent agent API requests: `Authorization: Bearer <token>`
- When token expires, call login again to get a new one

---

### Update Agent Info

```
POST /private/agent/update
Content-Type: application/json
Authorization: Bearer <JWT>
```

Update agent capabilities, tier, or system info.

**Request body**

```json
{
  "capabilities": ["llm.mistral", "llm.qwen", "vision[gpu;cuda12.1]"],
  "tier": 6,
  "capacity": 8,
  "displayName": "RTX 4090 Workstation 32GB",
  "systemInfo": {
    "os": "Linux",
    "client": "offload-agent/0.1.1",
    "runtime": "Python 3.11",
    "cpuArch": "aarch64",
    "totalMemoryGb": 32,
    "gpu": {
      "vendor": "NVIDIA",
      "model": "RTX 4090",
      "vramGb": 24
    }
  }
}
```

**Response** (200 OK)

```json
{
  "agentId": "agent-abc123def456",
  "key": "my-secret-login-token-12345",
  "message": "Updated"
}
```

---

### Poll Urgent Tasks

```
GET /private/agent/task/poll_urgent
Authorization: Bearer <JWT>
```

Fetch an urgent task matching your capabilities. Non-blocking — returns `null` if no tasks available.

**Response** (200 OK)

With available task:
```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "data": {
    "apiKey": "client-key",
    "capability": "llm.mistral",
    "payload": {
      "prompt": "What is 2+2?",
      "model": "mistral-7b"
    },
    "urgent": true,
    "restartable": true,
    "fileBucket": ["bucket-uid-1"],
    "fetchFiles": [],
    "artifacts": []
  },
  "createdAt": "2026-03-18T10:30:45.123Z"
}
```

No tasks available:
```json
null
```

| Field | Description |
|-------|-------------|
| `id` | Task identifier (cap + id) |
| `data` | Full task submission request from client |
| `data.fileBucket` | List of bucket UIDs you can download input files from via `GET /private/agent/bucket/{bucket_uid}/file/{file_uid}` |
| `data.outputBucket` | Optional bucket UID where you should upload output files via `POST /private/agent/bucket/{bucket_uid}/upload` |
| `data.payload` | The client's task payload |
| `createdAt` | When the task was submitted |

**Notes**

- Urgent tasks have 60s TTL; if not picked up, they're auto-expired
- Updates `last_contact` timestamp (agents offline > 120s are removed)
- Returns `null` if no urgent tasks matching your capabilities exist

---

### Poll Non-Urgent Tasks

```
GET /private/agent/task/poll
Authorization: Bearer <JWT>
```

Fetch a non-urgent (persistent) task matching your capabilities and tier. Always checks urgent queue first. Non-blocking.

**Response** (200 OK)

Same structure as urgent polling, but tasks come from persistent DB.

**Tier-Based Scheduling**

When multiple agents can handle a task:
1. Find the **highest tier** among all online agents with the required capability
2. If your tier < max tier, **skip this task** (reserved for higher-tier agents)
3. If your tier >= max tier, you're eligible; receive a random eligible task
4. This ensures premium agents get priority while fallback agents still get work

**Notes**

- Non-urgent tasks persist for days; no TTL pressure
- Updates `last_contact` timestamp
- Tier-based scheduling ensures optimal resource usage

---

### Claim Task

```
POST /private/agent/take/{cap}/{id}
Authorization: Bearer <JWT>
```

Claim a task you polled and transition it to "assigned" state.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `cap` | string | The capability (URL-encoded if needed) |
| `id` | string | The task ID |

**Response** (200 OK)

```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "data": {
    "apiKey": "client-key",
    "capability": "llm.mistral",
    "payload": {
      "prompt": "What is 2+2?",
      "model": "mistral-7b"
    },
    "urgent": true,
    "restartable": true,
    "fileBucket": ["bucket-uid-1"],
    "fetchFiles": [],
    "artifacts": []
  }
}
```

**Error responses**

| Status | Reason |
|--------|--------|
| `404` | Task not found (already claimed, expired, or never existed) |
| `409` | Task already claimed by another agent |
| `500` | Server error claiming task |

**Notes**

- Atomic operation: either you claim it or someone else does
- Once claimed, task transitions from "queued" → "assigned"
- For urgent tasks, `take` notifies waiting client via watch channel

---

### Report Task Completion

```
POST /private/agent/task/resolve/{cap}/{id}
Authorization: Bearer <JWT>
Content-Type: application/json
```

Report that you've completed (or failed) the task. Final state transition.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `cap` | string | The capability (URL-encoded if needed) |
| `id` | string | The task ID |

**Request body**

```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "capability": "llm.mistral",
  "status": {
    "Success": 0.95
  },
  "output": {
    "result": "2 + 2 = 4",
    "tokens_used": 15,
    "inference_time_ms": 245
  }
}
```

Or on failure:

```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "capability": "llm.mistral",
  "status": {
    "Failure": ["Out of memory", 0.0]
  },
  "output": {
    "error": "OOM while loading model",
    "error_code": "OOM"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | TaskId | The task you're resolving |
| `capability` | string | The task's capability |
| `status` | enum | Result status: `Success(confidence)` or `Failure(error_msg, confidence)` or `NotExecuted(reason)` |
| `output` | object | Task result or error details (any valid JSON) |

**Response** (200 OK)

```json
{
  "message": "task report confirmed"
}
```

**Error responses**

| Status | Reason |
|--------|--------|
| `400` | Task ID mismatch or malformed request |
| `404` | Task not found |
| `500` | Server error saving result |

**Notes**

- For urgent tasks, resolving triggers the watch channel to unblock waiting client
- Regular tasks are stored in persistent DB
- Task transitions to "completed" or "failed" state
- Once resolved, you're done; client polls to get the result

---

### Report Task Progress

```
POST /private/agent/task/progress/{cap}/{id}
Authorization: Bearer <JWT>
Content-Type: application/json
```

Send intermediate progress updates. Optional — use to provide logs and stage information while working.

**Path parameters**

Same as `/task/resolve`

**Request body**

```json
{
  "id": {
    "cap": "llm.mistral",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "stage": "inference",
  "log_update": "Loading model from /models/mistral-7b...\nModel loaded in 2.5s\nProcessing prompt...\n"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | TaskId | The task you're updating |
| `stage` | string | Optional: human-readable current stage (e.g., "downloading", "processing", "uploading") |
| `log_update` | string | Optional: append to task logs (multi-line text) |

**Response** (200 OK)

```json
{
  "message": "task update confirmed"
}
```

**Notes**

- Non-blocking: updates are appended to task logs
- Multiple progress updates are concatenated in order
- Stage information is shown in client status polls
- Useful for providing visibility into long-running tasks
- Can be called many times; no limit on frequency

---

### Upload Output File to Bucket

```
POST /private/agent/bucket/{bucket_uid}/upload
Authorization: Bearer <JWT>
Content-Type: multipart/form-data
```

Upload an output file (e.g., generated image or video) to the task's output bucket. Only meaningful when the task provides an `outputBucket` UID in its `data` field.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `bucket_uid` | string | The output bucket UID from `task.data.outputBucket` |

**Form fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The output file to store |

**Response** (201 Created)

```json
{
  "file_uid": "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
  "original_name": "ComfyUI_00001_.png",
  "size": 1234567,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

**Error responses**

| Status | Reason |
|--------|--------|
| `400` | No `file` field in multipart body, or file exceeds bucket remaining space |
| `404` | Bucket not found |
| `500` | Server error storing file |

**Notes**

- Any authenticated agent can write to any bucket; unguessable UUIDs act as capability tokens — agents only learn the output bucket UID from task data
- Once uploaded, include the `file_uid` and `bucket_uid` in the task's resolve output so the client knows how to download results
- The bucket is owned by the client and subject to the same size limits and TTL as input buckets (default 1 GiB per bucket, 24h TTL)

---

### Download Files from Bucket

```
GET /private/agent/bucket/{bucket_uid}/file/{file_uid}
Authorization: Bearer <JWT>
```

Download a file from a task's input bucket. Only works for buckets listed in the task's `fileBucket` field.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `bucket_uid` | string | The bucket UID from task submission |
| `file_uid` | string | The file UID from bucket listing |

**Response** (200 OK)

Binary file data with headers:
```
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="model.onnx"
Content-Length: 1234567
```

**Error responses**

| Status | Reason |
|--------|--------|
| `404` | Bucket or file not found |
| `500` | Server error retrieving file |

**Notes**

- Any authenticated agent can access any bucket (unguessable UUIDs act as tokens)
- Files can only be downloaded once (by the agent executing the task)
- Agents learn bucket UIDs from task assignment — clients never expose them
- Download through this endpoint, not direct HTTP

---

## Task Lifecycle

```
Client Submission
     ↓
[Urgent] ──────────────────────→  In-Memory Queue (60s TTL)
                                        ↓
[Regular] ──────────────────────→  Persistent DB
     ↓
[Agent Polls]  (urgent first, then regular)
     ↓
[Agent Claims]  (POST /take/{cap}/{id})
     Task: queued → assigned
     ↓
[Agent Executes & Updates]  (POST /progress/{cap}/{id})
     Task: starting → running
     ↓
[Agent Resolves]  (POST /resolve/{cap}/{id})
     Task: running → completed/failed
     ↓
[Client Polls]  (POST /poll/{cap}/{id})
     Gets result from completed task
     ↓
[Archived]  (after 7 days, configurable)
```

### State Diagram

| From | Event | To | Notes |
|------|-------|----|----|
| `pending` | Task queued by server | `queued` | Immediate for regular, after poll for urgent |
| `queued` | Agent claims (POST /take) | `assigned` | Exact transfer point |
| `assigned` | Agent updates (POST /progress) | `starting` | Optional; agent may skip to `running` |
| `starting` \| `queued` | Agent sends progress | `running` | When log/stage is first sent |
| `running` | Agent sends more progress | `running` | Logs/stage accumulate |
| `running` | Agent reports success (POST /resolve) | `completed` | Result available in `output` |
| `running` | Agent reports failure (POST /resolve) | `failed` | Error details in `output` |
| `completed` \| `failed` | 7 days pass | (archived) | No longer pollable (404) |

---

## Status Codes

### Successful Responses

| Code | Meaning | Endpoint |
|------|---------|----------|
| `200 OK` | Request succeeded | Poll, login, progress, resolve, update |
| `201 Created` | Resource created | Submit task (regular), register agent |
| `202 Accepted` | Request accepted, processing | Submit blocking, submit urgent |

### Client Errors

| Code | Meaning | Common Reasons |
|------|---------|----------------|
| `400 Bad Request` | Malformed request | Invalid JSON, missing required field, invalid capability format |
| `401 Unauthorized` | Auth failed | Missing/invalid api_key, API key lacks capability |
| `403 Forbidden` | Access denied | Bucket not owned by API key, insufficient permissions |
| `404 Not Found` | Resource missing | Task not found, bucket not found, agent not found |
| `408 Timeout` | Timeout waiting | `/submit_blocking` waited 60s with no result |
| `409 Conflict` | Conflict | Task already claimed by another agent |
| `413 Payload Too Large` | File too large | Upload exceeds bucket size limit |

### Server Errors

| Code | Meaning |
|------|---------|
| `500 Internal Server Error` | Database error, file store error, other server-side failures |

---

## Examples

### Python Client - Submit and Poll

```python
import requests
import time
import json

BASE_URL = "http://localhost:3069"
API_KEY = "my-client-key"

# 1. Submit a regular task
task_payload = {
    "apiKey": API_KEY,
    "capability": "llm.mistral",
    "payload": {
        "prompt": "What is the capital of France?",
        "model": "mistral-7b",
        "max_tokens": 100
    },
    "urgent": False,
    "restartable": True
}

response = requests.post(f"{BASE_URL}/api/task/submit", json=task_payload)
task_data = response.json()
task_id = task_data["id"]
print(f"Submitted task: {task_id}")

# 2. Poll task status until complete
while True:
    poll_payload = {"apiKey": API_KEY}
    response = requests.post(
        f"{BASE_URL}/api/task/poll/{task_id['cap']}/{task_id['id']}",
        json=poll_payload
    )
    status_data = response.json()
    print(f"Status: {status_data['status']}, Stage: {status_data.get('stage')}")

    if status_data["status"] in ["completed", "failed"]:
        print(f"Result: {status_data.get('output')}")
        print(f"Logs:\n{status_data.get('log')}")
        break

    time.sleep(1)
```

### Python Client - Blocking Submit

```python
import requests

BASE_URL = "http://localhost:3069"
API_KEY = "my-client-key"

# Submit and wait synchronously (60s timeout built-in)
task_payload = {
    "apiKey": API_KEY,
    "capability": "llm.mistral",
    "payload": {
        "prompt": "2+2=?",
        "model": "mistral-7b"
    },
    "urgent": True  # Must be True for blocking
}

try:
    response = requests.post(
        f"{BASE_URL}/api/task/submit_blocking",
        json=task_payload,
        timeout=65  # Slightly longer than server's 60s
    )
    result = response.json()
    print(f"Result: {result['output']}")
except requests.Timeout:
    print("Task timed out after 60s (still running on server)")
```

### Python Agent - Register, Poll, Execute

```python
import requests
import json
import time

BASE_URL = "http://localhost:3069"

# 1. Register agent
register_payload = {
    "apiKey": "agent-registration-key",
    "capabilities": ["llm.mistral", "vision"],
    "tier": 5,
    "capacity": 4,
    "systemInfo": {
        "os": "Linux",
        "client": "offload-agent/0.1.0",
        "runtime": "Python 3.11",
        "cpuArch": "x86_64",
        "totalMemoryGb": 16,
        "gpu": {
            "vendor": "NVIDIA",
            "model": "RTX 3080",
            "vramGb": 10
        }
    }
}

response = requests.post(f"{BASE_URL}/private/agent/register", json=register_payload)
agent_data = response.json()
agent_id = agent_data["agentId"]
agent_key = agent_data["key"]
print(f"Registered agent: {agent_id}")

# 2. Login to get JWT
login_payload = {
    "agentId": agent_id,
    "key": agent_key
}

response = requests.post(f"{BASE_URL}/private/agent/login", json=login_payload)
auth_data = response.json()
jwt_token = auth_data["token"]
headers = {"Authorization": f"Bearer {jwt_token}"}
print(f"Logged in, token expires in {auth_data['expiresIn']}s")

# 3. Poll for tasks
while True:
    response = requests.get(f"{BASE_URL}/private/agent/task/poll", headers=headers)
    task = response.json()

    if task is None:
        print("No tasks available, waiting...")
        time.sleep(2)
        continue

    task_id = task["id"]
    task_data = task["data"]
    print(f"Got task: {task_id}")
    print(f"Payload: {task_data['payload']}")

    # 4. Claim the task
    cap = task_id["cap"]
    task_id_str = task_id["id"]
    response = requests.post(
        f"{BASE_URL}/private/agent/take/{cap}/{task_id_str}",
        headers=headers
    )
    print("Task claimed")

    # 5. Send progress updates
    progress_payload = {
        "id": task_id,
        "stage": "inference",
        "log_update": "Loading model...\n"
    }
    requests.post(
        f"{BASE_URL}/private/agent/task/progress/{cap}/{task_id_str}",
        json=progress_payload,
        headers=headers
    )

    # Execute task (simulate)
    time.sleep(1)

    # 6. Report completion
    resolve_payload = {
        "id": task_id,
        "capability": cap,
        "status": {"Success": 0.95},
        "output": {
            "result": "The capital of France is Paris.",
            "confidence": 0.99
        }
    }
    response = requests.post(
        f"{BASE_URL}/private/agent/task/resolve/{cap}/{task_id_str}",
        json=resolve_payload,
        headers=headers
    )
    print("Task completed and reported")

    # Get next task
    break  # or continue loop
```

### cURL - Submit Task

```bash
curl -X POST http://localhost:3069/api/task/submit \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "my-client-key",
    "capability": "llm.mistral",
    "payload": {"prompt": "2+2=?"},
    "urgent": false
  }'
```

### cURL - Poll Task Status

```bash
# Extract task ID from previous response
TASK_CAP="llm.mistral"
TASK_ID="01ARZ3NDE4V2XTGZUVY7"

curl -X POST "http://localhost:3069/api/task/poll/$TASK_CAP/$TASK_ID" \
  -H "Content-Type: application/json" \
  -d '{"apiKey": "my-client-key"}'
```

---

## Advanced

### File References (fetchFiles, artifacts)

Tasks can specify HTTP fetch rules and artifact definitions:

```json
{
  "fetchFiles": [
    {
      "path": "/inputs/model.onnx",
      "get": "https://example.com/models/mistral-7b.onnx"
    },
    {
      "path": "/inputs/data.json",
      "s3_file": "s3://my-bucket/data.json"
    }
  ],
  "artifacts": [
    {
      "path": "/outputs/result.json",
      "post": "https://example.com/results"
    }
  ]
}
```

These are agent-specific; servers don't validate or enforce them — agents interpret fetch rules and handle artifact uploads.

### Extended Capabilities

Agents register with extended attributes:

```json
{
  "capabilities": [
    "llm.mistral",
    "llm.qwen3:8b[vision;tools;8b]",
    "vision[gpu;cuda12.1;fp16]"
  ]
}
```

Clients submit with base capability only:

```json
{
  "capability": "llm.qwen3:8b"
}
```

Server strips brackets when matching: `"llm.qwen3:8b[vision;tools;8b]"` matches tasks requiring `"llm.qwen3:8b"`.

---

## Configuration

Server-side task behavior is configured via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `URGENT_TASK_TTL_SECONDS` | 60 | Urgent task lifetime (in-memory) |
| `URGENT_EXPIRATION_CHECK_INTERVAL_SECS` | 10 | How often to clean expired urgent tasks |
| `SERVER_ADDRESS` | `0.0.0.0:3069` | HTTP server bind address |

---

## Notes & Best Practices

1. **Always use HTTPS in production** — don't send API keys over plain HTTP
2. **Store JWT tokens securely** — treat them like passwords
3. **Handle timeouts gracefully** — `/submit_blocking` has a 60s limit; plan accordingly
4. **Validate bucket ownership** — servers enforce it, but clients should double-check
5. **Resend progress updates** — if an update fails, the task is still running; retry
6. **Poll with backoff** — don't poll too aggressively; exponential backoff is better
7. **Clean up old tasks** — archived tasks are deleted after 7 days; plan data retention
8. **Use tier strategically** — higher tiers get better hardware; price accordingly

