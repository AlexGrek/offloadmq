# Management API

Administrative endpoints for monitoring and managing agents, tasks, and client API keys. Storage management is documented separately in [management-storage-api.md](management-storage-api.md).

**Base path:** `/management/*`
**Authentication:** `Authorization: Bearer <management_token>` header

---

## Table of Contents

1. [Overview](#overview)
2. [Version & Health](#version--health)
3. [Capabilities](#capabilities)
4. [Agents](#agents)
5. [Tasks](#tasks)
6. [Client API Keys](#client-api-keys)
7. [Heuristics](#heuristics)
8. [Maintenance Jobs](#maintenance-jobs)
9. [Service Logs](#service-logs)
10. [Examples](#examples)

---

## Overview

The management API is the control plane for OffloadMQ. It provides:

- **Monitoring** — List agents, tasks, capabilities
- **Management** — Create/revoke API keys, remove agents, reset tasks
- **Inspection** — View system version, online agent status

All endpoints require the `MGMT_TOKEN` environment variable set at server startup. Pass it as:

```
Authorization: Bearer <your-management-token>
```

---

## Version & Health

### Get Server Version

```
GET /management/version
Authorization: Bearer <token>
```

Returns the application version.

**Response** (200 OK)

```json
{
  "version": "0.1.142"
}
```

---

## Capabilities

### List Online Capabilities (Base)

```
GET /management/capabilities/list/online
Authorization: Bearer <token>
```

Returns a set of base capabilities (without extended attributes) provided by all online agents.

**Response** (200 OK)

```json
[
  "llm.mistral",
  "llm.qwen3:8b",
  "vision",
  "database.postgresql"
]
```

**Notes**

- Only includes agents online within the last 120 seconds
- Extended attributes in brackets are stripped (e.g., `"llm.mistral[7b;fp16]"` becomes `"llm.mistral"`)
- Deduplicated set — each capability appears once
- Useful for client-facing capability discovery

---

### List Online Capabilities (Extended)

```
GET /management/capabilities/list/online_ext
Authorization: Bearer <token>
```

Returns raw capabilities including extended attributes from all online agents. Useful for detailed inspection of agent capabilities.

**Response** (200 OK)

```json
[
  "llm.mistral",
  "llm.qwen3:8b[vision;tools;8b]",
  "vision[gpu;cuda12.1;fp16]",
  "database.postgresql[replication;streaming]"
]
```

**Notes**

- Only online agents (< 120s since last contact)
- Extended attributes in brackets are preserved
- Useful for debugging agent registration and capability metadata
- Deduplicated set

---

## Agents

### List All Agents

```
GET /management/agents/list
Authorization: Bearer <token>
```

Returns all registered agents (online and offline).

**Response** (200 OK)

```json
[
  {
    "uid": "01ARZ3NDE4V2XTGZUVY7",
    "uidShort": "ZUV7",
    "personalLoginToken": "abc-123-def-456",
    "registeredAt": "2026-03-17T10:00:00Z",
    "lastContact": "2026-03-18T14:30:22Z",
    "displayName": "Apple M3 Pro 16GB",
    "capabilities": ["llm.mistral", "vision[gpu;cuda12.1]"],
    "tier": 5,
    "capacity": 4,
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
]
```

| Field | Description |
|-------|-------------|
| `uid` | Unique agent identifier (time-sortable UUID) |
| `uidShort` | Last 6 chars of UID (used in logs) |
| `personalLoginToken` | Secret token for agent login (reveals personal key here — guard carefully) |
| `registeredAt` | ISO 8601 timestamp when agent registered |
| `lastContact` | Last time agent polled for tasks (null if never contacted) |
| `displayName` | Human-readable name (max 50 chars). Set at registration; null if agent did not provide one. |
| `capabilities` | List of capabilities with optional extended attributes in brackets |
| `tier` | Performance tier (0-255, higher is better) |
| `capacity` | Max concurrent tasks this agent can handle |
| `systemInfo` | Agent's reported system details (OS, memory, GPU, etc.) |
| `systemInfo.totalMemoryGb` | Total system RAM as a whole number of gigabytes |
| `systemInfo.gpu.vramGb` | GPU VRAM as a whole number of gigabytes (0 if unknown) |

---

### List Online Agents

```
GET /management/agents/list/online
Authorization: Bearer <token>
```

Returns only agents that have contacted the server within the last 120 seconds.

**Response** (200 OK)

Same structure as `/agents/list`, but filtered to online agents only.

```json
[
  {
    "uid": "01ARZ3NDE4V2XTGZUVY7",
    "uidShort": "ZUV7",
    "lastContact": "2026-03-18T14:30:22Z",
    ...
  }
]
```

**Notes**

- Online threshold: `lastContact` is within 120 seconds of now
- Useful for determining which agents can immediately accept work
- Agents with `lastContact: null` are never considered online

---

### Delete Agent

```
POST /management/agents/delete/{agent_id}
Authorization: Bearer <token>
```

Permanently removes an agent from the registry. Any tasks assigned to this agent will remain in "assigned" state.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent_id` | string | The agent UID to delete (e.g., `01ARZ3NDE4V2XTGZUVY7`) |

**Response** (200 OK)

```json
"Agent deleted"
```

**Error responses**

| Status | Reason |
|--------|--------|
| `404` | Agent not found |
| `500` | Database error |

**Notes**

- This is a hard delete — agent cannot log back in with the same credentials
- Tasks already assigned remain assigned (hanging in "assigned" state)
- After deletion, agent cannot re-register with the same ID

---

### Reset All Agents

```
POST /management/agents/reset
Authorization: Bearer <token>
```

Clears all agents from the registry. **Destructive operation**.

**Response** (200 OK)

```json
{
  "result": "Reset successful"
}
```

**Notes**

- Deletes all agent records
- Any running tasks remain in their current state (assigned to now-deleted agents)
- Agents will need to re-register to work again
- Use with extreme caution

---

## Tasks

### List All Tasks

```
GET /management/tasks/list
Authorization: Bearer <token>
```

Returns all tasks (urgent and regular, assigned and unassigned) in the system.

**Response** (200 OK)

```json
{
  "urgent": {
    "assigned": [
      {
        "id": {
          "cap": "llm.mistral",
          "id": "01ARZ3NDE4V2XTGZUVY7"
        },
        "data": {
          "apiKey": "client-key",
          "capability": "llm.mistral",
          "payload": {...},
          "urgent": true,
          "file_bucket": []
        },
        "created_at": "2026-03-18T14:30:00Z",
        "assignedTask": {
          "id": {...},
          "data": {...},
          "agentId": "agent-id",
          "createdAt": "2026-03-18T14:30:00Z",
          "assignedAt": "2026-03-18T14:30:05Z",
          "status": "assigned",
          "history": [...],
          "result": null,
          "log": null,
          "stage": null
        }
      }
    ],
    "unassigned": [
      {
        "id": {
          "cap": "llm.qwen",
          "id": "01ARZ3NDE4V2XTGZUVY8"
        },
        "data": {...},
        "created_at": "2026-03-18T14:25:00Z"
      }
    ]
  },
  "regular": {
    "assigned": [...],
    "unassigned": [...]
  }
}
```

| Field | Description |
|-------|-------------|
| `urgent.assigned` | Urgent tasks claimed by an agent (in-memory, 60s TTL) |
| `urgent.unassigned` | Urgent tasks waiting for an agent (in-memory, 60s TTL) |
| `regular.assigned` | Non-urgent tasks claimed by an agent (persisted) |
| `regular.unassigned` | Non-urgent tasks waiting for an agent (persisted) |

**AssignedTask fields**

| Field | Description |
|-------|-------------|
| `agentId` | The agent currently executing the task |
| `status` | Task status (queued, assigned, starting, running, completed, failed, etc.) |
| `history` | Array of state transitions with timestamps |
| `result` | Task output (populated on success/failure) |
| `log` | Accumulated logs from agent |
| `stage` | Current execution stage (e.g., "inference") |

---

### Reset All Tasks

```
POST /management/tasks/reset
Authorization: Bearer <token>
```

Clears all tasks from both in-memory and persistent storage. **Destructive operation**.

**Response** (200 OK)

```json
{
  "result": "Reset successful"
}
```

**Error responses**

| Status | Reason |
|--------|--------|
| `500` | Database error |

**Notes**

- Deletes all urgent and regular tasks
- Any task results are permanently lost
- Clients polling for results will get 404 (task not found)
- Use only for testing or recovery scenarios

---

## Client API Keys

### List Client API Keys

```
GET /management/client_api_keys/list
Authorization: Bearer <token>
```

Returns all client API keys and their permissions.

**Response** (200 OK)

```json
[
  {
    "key": "my-client-key",
    "capabilities": ["llm.mistral", "vision"],
    "isPredefined": true,
    "created": "2026-03-17T10:00:00Z",
    "isRevoked": false
  },
  {
    "key": "api-key-abc-123",
    "capabilities": ["database.postgresql"],
    "isPredefined": false,
    "created": "2026-03-18T09:00:00Z",
    "isRevoked": true
  }
]
```

| Field | Description |
|-------|-------------|
| `key` | The API key string (clients use this in requests) |
| `capabilities` | List of capabilities this key is authorized to submit tasks for |
| `isPredefined` | True if created via `CLIENT_API_KEYS` env var, false if created via management API |
| `created` | ISO 8601 timestamp when the key was created |
| `isRevoked` | True if key has been revoked and is no longer usable |

---

### Create or Update Client API Key

```
POST /management/client_api_keys/update
Authorization: Bearer <token>
Content-Type: application/json
```

Create a new client API key or update an existing one's capabilities.

**Request body**

```json
{
  "key": "new-client-key-456",
  "capabilities": ["llm.mistral", "llm.qwen", "vision"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | Yes | The API key string (should be random and unguessable) |
| `capabilities` | string[] | Yes | List of capabilities this key can submit tasks for |

**Response** (200 OK)

```json
{
  "key": "new-client-key-456",
  "capabilities": ["llm.mistral", "llm.qwen", "vision"],
  "isPredefined": false,
  "created": "2026-03-18T14:30:00Z",
  "isRevoked": false
}
```

**Error responses**

| Status | Reason |
|--------|--------|
| `400` | Malformed request (missing key or capabilities) |
| `500` | Database error |

**Notes**

- If the key already exists, its capabilities are updated
- `is_predefined` is set to `false` for keys created via this endpoint
- `created` timestamp reflects the original creation time (not update time)
- Use this to dynamically provision API keys for new clients

---

### Revoke Client API Key

```
POST /management/client_api_keys/revoke/{id}
Authorization: Bearer <token>
```

Mark a client API key as revoked. Clients using this key will receive `401 Unauthorized`.

**Path parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | The API key to revoke (e.g., `my-client-key`) |

**Response** (200 OK)

```json
{
  "key": "my-client-key",
  "capabilities": ["llm.mistral", "vision"],
  "isPredefined": true,
  "created": "2026-03-17T10:00:00Z",
  "isRevoked": true
}
```

**Error responses**

| Status | Reason |
|--------|--------|
| `404` | API key not found |
| `500` | Database error |

**Notes**

- Revocation is immediate — clients using the key will fail on next request
- The key is not deleted, only marked as revoked
- Can be un-revoked by updating the key with `is_revoked: false` (if that feature is added)
- Existing tasks from this key are not affected (continue executing)
- Future task submissions with this key will be rejected

---

## Heuristics

Heuristics records capture execution timing and success/failure data for every completed non-urgent task. The server uses this data to estimate how long a task will typically take when an agent claims it (see `typicalRuntimeSeconds` in the [Tasks API](tasks-api.md)).

### List Heuristic Records

```
GET /management/heuristics/records
Authorization: Bearer <token>
```

Paginated listing of raw heuristic records. Supports filtering by capability, runner, or machine.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `capability` | string | No | Filter by base capability (e.g. `llm.mistral`) |
| `runner_id` | string | No | Filter by agent UID |
| `machine_id` | string | No | Filter by machine ID (aggregates across agents sharing the same host) |
| `limit` | integer | No | Max records per page (default: 50, max: 500) |
| `cursor` | string | No | Cursor from previous page's `next_cursor`. Omit for first page. |

**Response** (200 OK)

```json
{
  "count": 2,
  "items": [
    {
      "capability": "llm.mistral",
      "runnerId": "01ARZ3NDE4V2XTGZUVY7",
      "runnerTier": 5,
      "runnerOs": "Linux",
      "runnerCpuArch": "aarch64",
      "runnerTotalMemoryGb": 32,
      "machineId": "mac-pro-studio-01",
      "executionTimeMs": 12450.0,
      "success": true,
      "completedAt": "2026-03-18T14:30:22Z"
    }
  ],
  "next_cursor": "llm.mistral|01ARZ...|01BRZ..."
}
```

**Notes**

- Filter priority when multiple filters provided: `machine_id` > `runner_id` > `capability`
- Records only exist for non-urgent tasks
- `machineId` may be `null` if the agent did not report a machine ID

---

### Runner Execution Stats

```
GET /management/heuristics/stats/runners
Authorization: Bearer <token>
```

Aggregated execution statistics for each `(capability, runner)` pair.

**Response** (200 OK)

```json
{
  "count": 1,
  "items": [
    {
      "capability": "llm.mistral",
      "runnerId": "01ARZ3NDE4V2XTGZUVY7",
      "totalRuns": 120,
      "successCount": 115,
      "failCount": 5,
      "successPct": 95.83,
      "successAvgMs": 12200.0,
      "successMinMs": 9800.0,
      "successMaxMs": 15600.0,
      "failAvgMs": 3100.0,
      "failMinMs": 800.0,
      "failMaxMs": 5400.0
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `successPct` | Percentage of successful runs (0–100) |
| `successAvgMs` | Average duration of successful runs in milliseconds (`null` if no successes) |
| `successMinMs` | Fastest successful run in milliseconds |
| `successMaxMs` | Slowest successful run in milliseconds |
| `failAvgMs` | Average duration of failed runs (`null` if no failures) |

---

### Machine Execution Stats

```
GET /management/heuristics/stats/machines
Authorization: Bearer <token>
```

Same as runner stats, but aggregated per `(capability, machine_id)` pair. Useful for comparing performance across different host machines, regardless of which agent instance ran the task.

**Response** (200 OK)

```json
{
  "count": 1,
  "items": [
    {
      "capability": "llm.mistral",
      "machineId": "mac-pro-studio-01",
      "totalRuns": 240,
      "successCount": 232,
      "failCount": 8,
      "successPct": 96.67,
      "successAvgMs": 11800.0,
      "successMinMs": 9200.0,
      "successMaxMs": 14900.0,
      "failAvgMs": 2800.0,
      "failMinMs": 600.0,
      "failMaxMs": 4900.0
    }
  ]
}
```

---

### Estimate Duration

```
GET /management/heuristics/estimate_duration?capability=<cap>&machine_id=<id>
Authorization: Bearer <token>
```

Returns the estimated typical execution time for a capability on a given machine, using the same two-level fallback rule that is applied when an agent claims a task:

1. **Machine-specific** — average of successful runs for `(machine_id, capability)`, if ≥ 2 exist.
2. **Global fallback** — average of all successful runs for `(capability)` across all machines, if ≥ 2 exist.
3. `null` if neither level has at least 2 successful runs.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `capability` | string | Yes | Base capability (e.g. `llm.mistral`) |
| `machine_id` | string | Yes | Machine ID to check first |

**Response** (200 OK)

```json
{
  "capability": "llm.mistral",
  "machineId": "mac-pro-studio-01",
  "estimatedMs": 11800
}
```

| Field | Description |
|-------|-------------|
| `estimatedMs` | Estimated duration in milliseconds. `null` if insufficient data. |

**Notes**

- This endpoint exposes the same logic used to populate `typicalRuntimeSeconds` on task status responses
- The estimate is based on successful runs only
- Minimum 2 successful runs required at each level before an estimate is returned

---

## Maintenance Jobs

Background cleanup jobs run automatically on a schedule, but can also be triggered on demand via these endpoints. Useful after bulk imports, debugging, or when you need immediate cleanup without waiting for the next scheduled run.

### Trigger Storage Cleanup

```
POST /management/storage/cleanup/trigger
Authorization: Bearer <token>
```

Immediately runs the expired-bucket cleanup job (same logic as the background task that runs every 3 hours).

Scans all buckets, finds those past their TTL (`STORAGE_BUCKET_TTL_MINUTES`, default: 1440 minutes / 24 h), deletes their files from the storage backend, and removes their metadata from the database.

**Response** (200 OK)

```json
{
  "deleted_count": 4
}
```

| Field | Description |
|-------|-------------|
| `deleted_count` | Number of expired buckets deleted in this run |

**Notes**

- Safe to call at any time — only deletes buckets that have already passed their TTL
- Bucket TTL is controlled by `STORAGE_BUCKET_TTL_MINUTES` env var
- File deletion failures are logged as warnings but do not fail the request
- A `deleted_count` of `0` means no buckets were expired at the time of the call

---

### Trigger Heuristics Cleanup

```
POST /management/heuristics/cleanup/trigger
Authorization: Bearer <token>
```

Immediately runs the heuristic record cleanup job (same logic as the background task that runs every 16–22 hours).

Performs two cleanup passes:
1. **By age** — deletes records older than `HEURISTICS_TTL_DAYS` (default: 7 days)
2. **By limit** — for each `(runner, capability)` pair, keeps only the newest `HEURISTICS_MAX_RECORDS_PER_RUNNER_CAP` records (default: 500)

**Response** (200 OK)

```json
{
  "deleted_by_age": 120,
  "deleted_by_limit": 35,
  "ttl_days": 7,
  "max_records_per_runner_cap": 500
}
```

| Field | Description |
|-------|-------------|
| `deleted_by_age` | Records deleted because they exceeded the TTL |
| `deleted_by_limit` | Records deleted because a (runner, capability) pair exceeded the max count |
| `ttl_days` | The TTL value used (reflects current server config) |
| `max_records_per_runner_cap` | The per-pair cap used (reflects current server config) |

**Notes**

- Only affects non-urgent task heuristic records
- Both thresholds are configurable via env vars: `HEURISTICS_TTL_DAYS`, `HEURISTICS_MAX_RECORDS_PER_RUNNER_CAP`
- Safe to run at any time; idempotent
- Both counts being `0` means the database was already within limits

---

### Trigger Stale Agents Cleanup

```
POST /management/agents/cleanup/trigger
Authorization: Bearer <token>
```

Immediately runs the stale agents cleanup job (same logic as the background task that runs every 16–22 hours).

Removes agents that have not been contacted for longer than `STALE_AGENTS_TTL_DAYS` (default: 7 days). Agents with no `lastContact` timestamp are also considered stale and will be deleted.

**Response** (200 OK)

```json
{
  "deleted": 3,
  "ttl_days": 7
}
```

| Field | Description |
|-------|-------------|
| `deleted` | Number of stale agents deleted in this run |
| `ttl_days` | The TTL value used (reflects current server config) |

**Notes**

- Safe to call at any time — only deletes agents that have exceeded the inactivity TTL
- Agent inactivity is measured from `lastContact` timestamp
- Agents with `lastContact: null` (never contacted) are considered stale
- Deleted agents cannot re-register with their original credentials
- TTL is controlled by `STALE_AGENTS_TTL_DAYS` env var
- Cleanup interval is randomized between `STALE_AGENTS_CLEANUP_INTERVAL_MIN_HOURS` and `STALE_AGENTS_CLEANUP_INTERVAL_MAX_HOURS` env vars

---

## Service Logs

Persistent log of internal system events emitted by background jobs and other server subsystems.

### List Service Messages

```
GET /management/service_logs?class=<class>&limit=<n>&cursor=<cursor>
Authorization: Bearer <token>
```

Returns paginated service messages filtered by `message_class`. The `class` parameter is **required** — requests without it are rejected.

**Query parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `class` | string | **Yes** | Message class to filter by (e.g. `bg`) |
| `limit` | integer | No | Max items per page (default: 50, max: 500) |
| `cursor` | string | No | `record_id` from the previous page's `next_cursor`. Omit for the first page |

**Response** (200 OK)

```json
{
  "class": "bg",
  "count": 2,
  "items": [
    {
      "messageClass": "bg",
      "messageKind": "heuristics-cleanup-job",
      "timestamp": "2026-03-23T04:00:00Z",
      "recordId": "01JVK3ABCDEF...",
      "messageContent": {
        "deleted_by_age": 12,
        "deleted_by_limit": 0,
        "ttl_days": 7,
        "max_records_per_runner_cap": 500
      }
    },
    {
      "messageClass": "bg",
      "messageKind": "storage-cleanup-job",
      "timestamp": "2026-03-23T03:00:00Z",
      "recordId": "01JVK3AAAAAA...",
      "messageContent": {
        "expired_found": 3,
        "deleted": 3,
        "errors": 0
      }
    }
  ],
  "next_cursor": "01JVK2ZZZZZZ..."
}
```

| Field | Description |
|-------|-------------|
| `class` | The class that was queried |
| `count` | Number of items returned in this page |
| `items` | Array of `ServiceMessage` objects, **newest first** |
| `items[].messageClass` | Message class |
| `items[].messageKind` | Message kind (not indexed — used for display only) |
| `items[].timestamp` | ISO 8601 UTC timestamp when the message was recorded |
| `items[].recordId` | Time-sortable unique ID for this message |
| `items[].messageContent` | Free-form JSON payload from the emitting subsystem |
| `next_cursor` | Pass as `cursor=` in the next request to get the following page. `null` means this is the last page |

**Notes**

- Items are returned newest-first within the class
- `cursor` is exclusive — the item with that `record_id` is not included in the next page
- Message kinds are not indexed; filter by kind client-side if needed

---

### Known Message Classes and Kinds

| Class | Kind | Emitted by | Content fields |
|-------|------|------------|----------------|
| `bg` | `heuristics-cleanup-job` | Heuristics background cleanup | `deleted_by_age`, `deleted_by_limit`, `ttl_days`, `max_records_per_runner_cap` (or `error` on failure) |
| `bg` | `storage-cleanup-job` | Bucket expiry background cleanup | `expired_found`, `deleted`, `errors` |
| `bg` | `stale-agents-cleanup-job` | Stale agents background cleanup | `deleted`, `ttl_days` (or `error` on failure) |

---

## Examples

### Python - Monitor Agents

```python
import requests
import time

BASE_URL = "http://localhost:3069"
MGMT_TOKEN = "my-management-token"
headers = {"Authorization": f"Bearer {MGMT_TOKEN}"}

# List all agents
response = requests.get(f"{BASE_URL}/management/agents/list", headers=headers)
all_agents = response.json()
print(f"Total agents: {len(all_agents)}")

# List online agents
response = requests.get(f"{BASE_URL}/management/agents/list/online", headers=headers)
online_agents = response.json()
print(f"Online agents: {len(online_agents)}")

for agent in online_agents:
    print(f"  - {agent['uidShort']}: {agent['capabilities']}")

# Get capabilities
response = requests.get(f"{BASE_URL}/management/capabilities/list/online", headers=headers)
caps = response.json()
print(f"Available capabilities: {caps}")
```

### Python - Manage API Keys

```python
import requests

BASE_URL = "http://localhost:3069"
MGMT_TOKEN = "my-management-token"
headers = {"Authorization": f"Bearer {MGMT_TOKEN}"}

# Create a new API key
new_key_request = {
    "key": "client-dataset-team-xyz",
    "capabilities": ["vision", "database.postgresql"]
}

response = requests.post(
    f"{BASE_URL}/management/client_api_keys/update",
    headers=headers,
    json=new_key_request
)
new_key = response.json()
print(f"Created key: {new_key['key']}")

# List all keys
response = requests.get(f"{BASE_URL}/management/client_api_keys/list", headers=headers)
all_keys = response.json()
for key in all_keys:
    status = "REVOKED" if key['isRevoked'] else "ACTIVE"
    print(f"{key['key']}: {status}, capabilities: {key['capabilities']}")

# Revoke a key
response = requests.post(
    f"{BASE_URL}/management/client_api_keys/revoke/old-client-key",
    headers=headers
)
revoked = response.json()
print(f"Revoked: {revoked['key']}")
```

### Python - Monitor Tasks

```python
import requests

BASE_URL = "http://localhost:3069"
MGMT_TOKEN = "my-management-token"
headers = {"Authorization": f"Bearer {MGMT_TOKEN}"}

response = requests.get(f"{BASE_URL}/management/tasks/list", headers=headers)
tasks = response.json()

print(f"Urgent assigned: {len(tasks['urgent']['assigned'])}")
print(f"Urgent unassigned: {len(tasks['urgent']['unassigned'])}")
print(f"Regular assigned: {len(tasks['regular']['assigned'])}")
print(f"Regular unassigned: {len(tasks['regular']['unassigned'])}")

# Check for stuck tasks (assigned but not progressing)
for task in tasks['regular']['assigned']:
    agent_id = task['agentId']
    status = task['status']
    print(f"Task {task['id']['id']}: assigned to {agent_id}, status: {status}")
```

### Python - Reset System (Testing Only)

```python
import requests

BASE_URL = "http://localhost:3069"
MGMT_TOKEN = "my-management-token"
headers = {"Authorization": f"Bearer {MGMT_TOKEN}"}

# Reset tasks
response = requests.post(f"{BASE_URL}/management/tasks/reset", headers=headers)
print(f"Tasks reset: {response.json()}")

# Reset agents
response = requests.post(f"{BASE_URL}/management/agents/reset", headers=headers)
print(f"Agents reset: {response.json()}")
```

### cURL - List Online Agents

```bash
MGMT_TOKEN="my-management-token"
BASE="http://localhost:3069"

curl -X GET "$BASE/management/agents/list/online" \
  -H "Authorization: Bearer $MGMT_TOKEN" | jq .
```

### cURL - Create API Key

```bash
MGMT_TOKEN="my-management-token"
BASE="http://localhost:3069"

curl -X POST "$BASE/management/client_api_keys/update" \
  -H "Authorization: Bearer $MGMT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "new-client-key-xyz",
    "capabilities": ["llm.mistral", "vision"]
  }' | jq .
```

### cURL - Get Tasks Summary

```bash
MGMT_TOKEN="my-management-token"
BASE="http://localhost:3069"

curl -X GET "$BASE/management/tasks/list" \
  -H "Authorization: Bearer $MGMT_TOKEN" | jq '.
    | {
      "urgent_assigned": (.urgent.assigned | length),
      "urgent_unassigned": (.urgent.unassigned | length),
      "regular_assigned": (.regular.assigned | length),
      "regular_unassigned": (.regular.unassigned | length)
    }'
```

---

## Using Client API with Management Token

The management token can also be used to call any client API endpoint (`/api/*`) via the `X-MGMT-API-KEY` header. This is useful for administrative operations like triggering slavemode commands from the management frontend without needing a separate client API key.

When `X-MGMT-API-KEY` is present and valid:

- The `apiKey` field in the JSON body is **not validated** (but must be present for JSON parsing)
- All capability restrictions are bypassed — any capability can be used
- Task ownership checks are bypassed on poll and cancel endpoints
- Bucket ownership checks are bypassed on submit endpoints

### Example: Trigger Force-Rescan on All Agents

```bash
MGMT_TOKEN="my-management-token"
BASE="http://localhost:3069"

curl -X POST "$BASE/api/task/submit" \
  -H "Content-Type: application/json" \
  -H "X-MGMT-API-KEY: $MGMT_TOKEN" \
  -d '{
    "capability": "slavemode.force-rescan",
    "payload": {},
    "apiKey": "mgmt"
  }' | jq .
```

### JavaScript (Management Frontend)

```js
const mgmtToken = localStorage.getItem('offload-mq-mgmt-token');

const res = await fetch('/api/task/submit', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-MGMT-API-KEY': mgmtToken,
  },
  body: JSON.stringify({
    capability: 'slavemode.force-rescan',
    payload: {},
    apiKey: 'mgmt',
  }),
});
const data = await res.json();
// data.id.id and data.id.cap for polling
```

**Note:** The `X-MGMT-API-KEY` header is only checked on `/api/*` routes (client API). Management routes (`/management/*`) continue to use `Authorization: Bearer <token>`.

---

## Configuration

The management endpoint is controlled via:

| Variable | Purpose |
|----------|---------|
| `MGMT_TOKEN` | Bearer token for all `/management/*` endpoints |

Example `.env`:

```bash
MGMT_TOKEN=super-secret-management-token-12345
```

---

## Best Practices

1. **Secure the management token** — treat it like a password; use environment variables or secrets managers
2. **Monitor online agents** — regularly check `/agents/list/online` to detect agent failures
3. **Audit API keys** — periodically review `/client_api_keys/list` and revoke unused keys
4. **Watch task queues** — check `/tasks/list` for stuck tasks or queue buildup
5. **Reset is destructive** — only use `/tasks/reset` and `/agents/reset` in test environments
6. **Use HTTPS in production** — management endpoints expose sensitive data
7. **Implement access controls** — restrict management endpoint access to authorized staff only
8. **Monitor capabilities** — track `/capabilities/list/online_ext` to verify agent health and configuration

---

## Related Documentation

- [Tasks API](tasks-api.md) — Detailed task submission, polling, and execution
- [Client Storage API](client-storage-api.md) — File bucket management for clients
- [Management Storage API](management-storage-api.md) — Administrative bucket inspection and cleanup
- [CLAUDE.md](../CLAUDE.md) — Architecture and configuration overview
