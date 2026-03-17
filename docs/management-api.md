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
7. [Examples](#examples)

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
    "uid_short": "ZUV7",
    "personal_login_token": "abc-123-def-456",
    "registered_at": "2026-03-17T10:00:00Z",
    "last_contact": "2026-03-18T14:30:22Z",
    "capabilities": ["llm.mistral", "vision[gpu;cuda12.1]"],
    "tier": 5,
    "capacity": 4,
    "system_info": {
      "os": "Linux",
      "client": "offload-agent/0.1.0",
      "runtime": "Python 3.11",
      "cpu_arch": "aarch64",
      "total_memory_mb": 32768,
      "gpu": {
        "vendor": "NVIDIA",
        "model": "RTX 4090",
        "vram_mb": 24576
      }
    }
  }
]
```

| Field | Description |
|-------|-------------|
| `uid` | Unique agent identifier (time-sortable UUID) |
| `uid_short` | Last 6 chars of UID (used in logs) |
| `personal_login_token` | Secret token for agent login (reveals personal key here — guard carefully) |
| `registered_at` | ISO 8601 timestamp when agent registered |
| `last_contact` | Last time agent polled for tasks (null if never contacted) |
| `capabilities` | List of capabilities with optional extended attributes in brackets |
| `tier` | Performance tier (0-255, higher is better) |
| `capacity` | Max concurrent tasks this agent can handle |
| `system_info` | Agent's reported system details (OS, memory, GPU, etc.) |

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
    "uid_short": "ZUV7",
    "last_contact": "2026-03-18T14:30:22Z",
    ...
  }
]
```

**Notes**

- Online threshold: `last_contact` is within 120 seconds of now
- Useful for determining which agents can immediately accept work
- Agents with `last_contact: null` are never considered online

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
          "api_key": "client-key",
          "capability": "llm.mistral",
          "payload": {...},
          "urgent": true,
          "file_bucket": []
        },
        "created_at": "2026-03-18T14:30:00Z",
        "assigned_task": {
          "id": {...},
          "data": {...},
          "agent_id": "agent-id",
          "created_at": "2026-03-18T14:30:00Z",
          "assigned_at": "2026-03-18T14:30:05Z",
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
| `agent_id` | The agent currently executing the task |
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
    "is_predefined": true,
    "created": "2026-03-17T10:00:00Z",
    "is_revoked": false
  },
  {
    "key": "api-key-abc-123",
    "capabilities": ["database.postgresql"],
    "is_predefined": false,
    "created": "2026-03-18T09:00:00Z",
    "is_revoked": true
  }
]
```

| Field | Description |
|-------|-------------|
| `key` | The API key string (clients use this in requests) |
| `capabilities` | List of capabilities this key is authorized to submit tasks for |
| `is_predefined` | True if created via `CLIENT_API_KEYS` env var, false if created via management API |
| `created` | ISO 8601 timestamp when the key was created |
| `is_revoked` | True if key has been revoked and is no longer usable |

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
  "is_predefined": false,
  "created": "2026-03-18T14:30:00Z",
  "is_revoked": false
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
  "is_predefined": true,
  "created": "2026-03-17T10:00:00Z",
  "is_revoked": true
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
    print(f"  - {agent['uid_short']}: {agent['capabilities']}")

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
    status = "REVOKED" if key['is_revoked'] else "ACTIVE"
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
    agent_id = task['agent_id']
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
