# Testing Guide

This document describes the testing infrastructure for OffloadMQ, including integration tests and how to run them.

## Overview

OffloadMQ includes comprehensive integration tests covering:

- **Smoke tests** — Basic task submission and execution
- **WebSocket tests** — Agent communication and heartbeats
- **Storage API tests** — File bucket management
- **Management API tests** — Administrative operations

**Test files location:** `itests/tests/`

- `test_smoke.py` — Task submission and execution (10 tests)
- `test_websocket.py` — WebSocket agent communication (3 tests)
- `test_storage_api.py` — Client storage API (18 tests)
- `test_management_api.py` — Management API (21 tests)

**Total: 52 integration tests**

## Running Tests

### Prerequisites

Ensure dependencies are installed:

```bash
cd itests
make venv
```

### Full Test Suite

Run all tests with server and agent startup/cleanup:

```bash
cd itests
make test-full
```

This will:
1. Create Python virtualenv
2. Start the MQ server
3. Start the agent
4. Run all pytest tests
5. Stop both services
6. Report results

### Manual Testing

For development, start services manually:

```bash
cd itests

# Terminal 1: Start server
make start-server

# Terminal 2: Start agent
make start-agent

# Terminal 3: Run tests
./venv/bin/pytest -v tests/

# Cleanup
make stop-all
```

### Run Specific Tests

```bash
# Storage API only
./venv/bin/pytest -v tests/test_storage_api.py

# Management API only
./venv/bin/pytest -v tests/test_management_api.py

# Specific test class
./venv/bin/pytest -v tests/test_storage_api.py::TestBucketLifecycle

# Single test
./venv/bin/pytest -v tests/test_storage_api.py::TestBucketLifecycle::test_create_bucket
```

### View Logs

```bash
make logs
```

Shows last 50 lines of server and agent logs.

---

## Test Details

### Smoke Tests (`test_smoke.py`)

Basic task submission and execution tests. Requires a running agent with `shell.bash` capability.

**Tests:**
- `test_simple_bash_command` — Execute basic echo command
- `test_bash_list_directory` — Execute ls command
- `test_bash_with_multiline` — Execute multi-line script
- `test_git_clone_fetch` — Fetch files via git clone
- `test_http_get_fetch` — Fetch files via HTTP GET
- `test_http_with_custom_header` — HTTP request with custom headers
- `test_multiple_fetch_files` — Fetch multiple files
- `test_urgent_task` — Submit urgent task (blocking)
- `test_restartable_task` — Submit restartable task
- `test_artifact_creation` — Create and return artifacts

**Status:** All passing when agent is online

---

### WebSocket Tests (`test_websocket.py`)

Tests WebSocket communication between agents and server.

**Authentication:**
- Tests register new agents dynamically
- Agents authenticate with JWT tokens
- Tests verify token validation

**Tests:**
- `test_websocket_connection_successful` — Establish WebSocket connection with valid JWT
- `test_websocket_connection_fails_with_invalid_token` — Reject invalid tokens
- `test_websocket_receives_heartbeat` — Receive server heartbeats every 5 seconds

**Messages:**
- Connection message includes `agent_id`
- Heartbeat includes `counter` and `timestamp`
- All messages are JSON-encoded

**Status:** All passing

---

### Storage API Tests (`test_storage_api.py`)

Comprehensive tests for the client-facing Storage API (`/api/storage/*`).

**Authentication:**
- Uses `X-API-Key` header (client API key)
- Missing or invalid key returns 401/403

**Tests by Category:**

#### Limits & Listing
- `test_get_limits` — Retrieve storage configuration
- `test_list_buckets_empty` — List buckets when none exist
- `test_get_limits_missing_api_key` — Verify auth enforcement

#### Bucket Lifecycle (6 tests)
- `test_create_bucket` — Create new bucket (201 Created)
- `test_list_buckets_empty` — List buckets when empty
- `test_create_and_list_bucket` — Create and verify in list
- `test_bucket_limit_enforcement` — Verify max bucket limit
- `test_delete_empty_bucket` — Delete empty bucket
- `test_delete_bucket_with_files` — Delete bucket with content

#### File Upload (5 tests)
- `test_upload_file` — Upload single file to bucket
- `test_upload_and_stat` — Upload and verify via /stat endpoint
- `test_upload_multiple_files` — Upload multiple files to same bucket
- `test_upload_large_file` — Upload 1MB file
- `test_upload_exceeds_bucket_size` — Reject oversized uploads

#### File Operations (3 tests)
- `test_get_file_hash` — Retrieve file SHA-256 hash
- `test_delete_file` — Delete single file from bucket
- `test_delete_nonexistent_file` — Handle missing file (404)

#### Authorization (1 test)
- `test_cannot_access_other_key_bucket` — Enforce API key isolation

**Key Findings:**

| Endpoint | Method | Status | Notes |
|----------|--------|--------|-------|
| `/api/storage/limits` | GET | 200 | Returns limits for this key |
| `/api/storage/buckets` | GET | 200 | Lists all buckets for key |
| `/api/storage/bucket/create` | POST | 201 | Creates bucket, enforces max limit |
| `/api/storage/bucket/{uid}/upload` | POST | 201 | Multipart form-data, enforces size limit |
| `/api/storage/bucket/{uid}/stat` | GET | 200 | Lists files and remaining space |
| `/api/storage/bucket/{uid}/file/{fid}/hash` | GET | 200 | Returns 64-char hex SHA-256 |
| `/api/storage/bucket/{uid}/file/{fid}` | DELETE | 200 | Removes file |
| `/api/storage/bucket/{uid}` | DELETE | 200 | Removes bucket and all files |

**Response Fields:**

Bucket list:
```json
{
  "buckets": [
    {
      "bucket_uid": "string",
      "created_at": "ISO8601",
      "file_count": 0,
      "used_bytes": 0,
      "remaining_bytes": 1073741824
    }
  ]
}
```

Bucket stat:
```json
{
  "files": [
    {
      "file_uid": "string",
      "size": 1234,
      "original_name": "filename.txt",
      "sha256": "hex string"
    }
  ],
  "used_bytes": 1234,
  "remaining_bytes": 1073741823
}
```

File upload response:
```json
{
  "file_uid": "string",
  "sha256": "hex string",
  "size": 1234
}
```

**Cleanup:** Tests use automatic fixture to purge all buckets before and after each test.

**Status:** All 18 tests passing

---

### Management API Tests (`test_management_api.py`)

Tests for administrative Management API (`/management/*`).

**Authentication:**
- Uses `Authorization: Bearer {token}` header
- Token from environment variable `MGMT_TOKEN`
- Missing/invalid token returns 401/403

**Tests by Category:**

#### Authentication (3 tests)
- `test_missing_management_token` — Request without token rejected
- `test_invalid_management_token` — Invalid token rejected
- `test_valid_management_token` — Valid token accepted

#### Agent Management (5 tests)
- `test_list_all_agents` — List all agents with details
- `test_list_online_agents` — List only online agents
- `test_capabilities_online` — Get available base capabilities
- `test_capabilities_online_extended` — Get capabilities with extended attributes
- `test_remove_agent` — Remove agent by ID

#### Task Management (3 tests)
- `test_list_all_tasks` — List all tasks (urgent/regular, assigned/unassigned)
- `test_reset_tasks` — Clear all tasks
- `test_reset_agents` — Clear all agents

#### Client Key Management (3 tests)
- `test_list_client_keys` — List all client API keys
- `test_add_client_key` — Create new client API key
- `test_revoke_client_key` — Revoke (disable) a client key

#### Storage Management (6 tests)
- `test_list_all_buckets` — List all buckets grouped by API key
- `test_list_storage_quotas` — Get storage limits and usage
- `test_list_storage_quotas_for_key` — Get usage for specific key
- `test_delete_bucket_via_management` — Delete specific bucket
- `test_delete_key_buckets` — Delete all buckets for a key
- `test_purge_all_buckets` — Delete all buckets system-wide

#### Version (1 test)
- `test_get_version` — Get server version info

**Key Findings:**

| Endpoint | Method | Status | Auth Header | Notes |
|----------|--------|--------|-------------|-------|
| `/management/agents/list` | GET | 200 | Bearer | All agents |
| `/management/agents/list/online` | GET | 200 | Bearer | Online only |
| `/management/agents/delete/{id}` | POST | 200 | Bearer | Remove agent |
| `/management/capabilities/list/online` | GET | 200 | Bearer | Base capabilities only |
| `/management/capabilities/list/online_ext` | GET | 200 | Bearer | With extended attributes |
| `/management/tasks/list` | GET | 200 | Bearer | All tasks by type |
| `/management/tasks/reset` | POST | 200 | Bearer | Clear all tasks |
| `/management/agents/reset` | POST | 200 | Bearer | Clear all agents |
| `/management/client_api_keys/list` | GET | 200 | Bearer | All keys |
| `/management/client_api_keys/update` | POST | 200 | Bearer | Create/update key |
| `/management/client_api_keys/revoke/{key}` | POST | 200 | Bearer | Disable key |
| `/management/storage/buckets` | GET | 200 | Bearer | All buckets by key |
| `/management/storage/buckets` | DELETE | 200 | Bearer | Purge all buckets |
| `/management/storage/quotas` | GET | 200 | Bearer | Limits + usage |
| `/management/storage/bucket/{uid}` | DELETE | 200 | Bearer | Delete bucket |
| `/management/storage/key/{key}/buckets` | DELETE | 200 | Bearer | Delete key's buckets |
| `/management/version` | GET | 200 | Bearer | Server version |

**Client Task API — capability discovery** (same JSON `apiKey` body and middleware as `POST /api/task/submit`; not covered by the management test module above):

| Endpoint | Method | Status | Auth | Notes |
|----------|--------|--------|------|-------|
| `/api/capabilities/online` | POST | 200 | JSON `apiKey` | Base capabilities; filtered by key |
| `/api/capabilities/list/online_ext` | POST | 200 | JSON `apiKey` | Raw capabilities with `[...]`; filtered by key (base match); optional `X-MGMT-API-KEY` for full set |

**Request/Response Examples:**

Create client key:
```bash
POST /management/client_api_keys/update
Authorization: Bearer this-is-for-testing-management-tokens

{
  "key": "test_key_12345",
  "capabilities": []
}
```

Response:
```json
{
  "key": "test_key_12345",
  "capabilities": [],
  "isPredefined": false,
  "created": "2026-03-17T23:02:45.067973Z",
  "isRevoked": false
}
```

Revoke key:
```bash
POST /management/client_api_keys/revoke/test_key_12345
Authorization: Bearer this-is-for-testing-management-tokens
```

Response:
```json
{
  "key": "test_key_12345",
  "capabilities": [],
  "isPredefined": false,
  "created": "2026-03-17T23:02:45.067973Z",
  "isRevoked": true
}
```

List tasks:
```json
{
  "urgent": {
    "assigned": [],
    "unassigned": []
  },
  "regular": {
    "assigned": [],
    "unassigned": []
  }
}
```

**Cleanup:** Tests use cleanup fixtures where needed. Note that `test_reset_agents` clears all agents, affecting subsequent smoke tests.

**Status:** All 21 tests passing

---

## Key Insights from Testing

### Authentication

1. **Storage API** uses `X-API-Key` header for client authentication
2. **Management API** uses `Authorization: Bearer {token}` for authentication
3. Missing/invalid credentials return 401 or 403 (both are acceptable)
4. API key isolation is enforced — clients cannot access other keys' resources

### Limits & Quotas

- **Max buckets per key:** 256 (default, configurable)
- **Max bucket size:** 1 GiB (default, configurable)
- **Bucket TTL:** 24 hours (default, configurable)
- **Exceeding limits returns 409 Conflict**

### File Operations

- Files are stored with SHA-256 digest computed at upload time
- File hash is accessible via dedicated endpoint (64-char hex string)
- File deletion updates bucket usage immediately
- Bucket deletion is atomic — removes all files and metadata

### Task Management

- Tasks are tracked separately: urgent (in-memory) and regular (persistent)
- Both assigned and unassigned tasks are queryable
- Reset operations clear entire categories atomically

### WebSocket Agent Communication

- Agents authenticate with JWT tokens (not API keys)
- Server sends heartbeat messages every 5 seconds
- Messages are JSON-encoded
- Connection message includes agent_id for identification

---

## Troubleshooting

### "Server failed to start" during `make test-full`

The first build takes time. The health check timeout is 10 seconds. If cargo compilation takes longer, increase the sleep in the Makefile or run `make start-server` separately first.

### "Bucket limit reached" errors in storage tests

Buckets from previous test runs may persist. Use management API to purge:

```bash
curl -X DELETE http://localhost:3069/management/storage/buckets \
  -H "Authorization: Bearer this-is-for-testing-management-tokens"
```

### Agent goes offline during tests

Some management tests reset agents. Run smoke tests separately with a fresh agent startup if needed.

### WebSocket tests timeout

Ensure agent is registered with capabilities before running WebSocket tests. Tests dynamically register agents, but may need time for heartbeats.

---

## CI/CD Integration

The test suite is designed for CI/CD pipelines:

```bash
cd itests
make test-full
```

Exit code is 0 on all tests passing, non-zero on any failure. Tests clean up after themselves, leaving the system ready for re-runs.

---

## Future Enhancements

1. **Performance tests** — Measure throughput and latency
2. **Chaos tests** — Network failures, server crashes, agent disconnects
3. **Load tests** — Multiple concurrent clients and large numbers of tasks
4. **Stress tests** — Large file uploads, many buckets, many agents
5. **Regression tests** — Track known issues and fixes
