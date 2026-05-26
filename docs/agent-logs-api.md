# Agent Logs API

OffloadMQ accepts free-form runtime log entries from authenticated agents and
exposes them through the management API for inspection. Records are stored in a
dedicated Sled tree (`agent_logs`) and pruned automatically after 14 days.

## Severity levels

Exactly three severities are recognized:

| Severity | Intended use                                            |
| -------- | ------------------------------------------------------- |
| CRITICAL | Unrecoverable agent failures — agent likely needs restart |
| ERROR    | Operation-level failures, exceptions, bad inputs         |
| INFO     | Lifecycle and progress notes useful for debugging        |

The strings are case-insensitive on submission but always returned uppercase.

## Storage layout

- Sled tree: `agent_logs`
- Key format: `{severity_prefix}|{agent_id}|{record_id}`
  - `severity_prefix` is a fixed 2-byte tag: `00` (CRITICAL), `10` (ERROR), `20` (INFO).
  - `record_id` is a time-sortable ULID issued by the server on ingest.
- Value: MessagePack-encoded `AgentLogRecord`.
- Retention: 14 days. A background job runs at startup and every 6 hours; it
  can also be triggered on demand via the management API.

## Record shape

```json
{
  "recordId": "01JZK7Q3...",
  "agentId":  "0193c1d5-...",
  "agentName": "workstation-01",
  "machineFingerprint": "fp_e7c3...",
  "severity": "ERROR",
  "text": "ollama: dial unix /var/run/ollama.sock: connect: no such file",
  "timestamp": "2026-05-26T10:42:11.123Z"
}
```

All fields except `agentName` and `machineFingerprint` are required. The server
fills `timestamp` and `recordId` on ingest; agents must never set them.

## Agent API

### `POST /private/agent/logs`

Submit a single log entry. Requires the standard agent JWT (same as other
`/private/agent/*` routes).

**Request body**

```json
{
  "severity": "ERROR",
  "text": "ollama call failed: timeout",
  "agentId": "0193c1d5-...",          // optional, defaults to authenticated agent uid
  "agentName": "workstation-01",      // optional, defaults to agent.displayName or uid_short
  "machineFingerprint": "fp_e7c3..."  // optional, defaults to agent.systemInfo.machineId
}
```

`agentId`, `agentName`, and `machineFingerprint` are stored as-is. When the
agent omits them, the server uses values from the authenticated agent record.

**Response**

```json
{
  "recordId": "01JZK7Q3...",
  "agentId": "0193c1d5-...",
  "agentName": "workstation-01",
  "machineFingerprint": "fp_e7c3...",
  "severity": "ERROR",
  "text": "ollama call failed: timeout",
  "timestamp": "2026-05-26T10:42:11.123Z"
}
```

**Errors**

- `400 Bad Request` — unknown severity (must be `CRITICAL`, `ERROR`, or `INFO`).

## Management API

All endpoints require the management token (`Authorization: Bearer <MGMT_TOKEN>`).

### `GET /management/agent_logs/by_severity`

Returns log records filtered by severity, newest first.

| Query param | Type    | Default | Description                                              |
| ----------- | ------- | ------- | -------------------------------------------------------- |
| `severity`  | string  | —       | `CRITICAL`, `ERROR`, or `INFO`. Required.                |
| `limit`     | integer | `100`   | Max records to return. Pass `-1` to return all.          |

Example:

```
GET /management/agent_logs/by_severity?severity=ERROR&limit=200
```

```json
{
  "severity": "ERROR",
  "count": 2,
  "items": [ { ...AgentLogRecord }, { ...AgentLogRecord } ]
}
```

### `GET /management/agent_logs/by_agent`

Returns log records for a specific agent across all severities, newest first.

| Query param | Type    | Default | Description                                       |
| ----------- | ------- | ------- | ------------------------------------------------- |
| `agent_id`  | string  | —       | Agent UID. Required.                              |
| `limit`     | integer | `100`   | Max records to return. Pass `-1` to return all.   |

Example:

```
GET /management/agent_logs/by_agent?agent_id=0193c1d5-...&limit=-1
```

```json
{
  "agentId": "0193c1d5-...",
  "count": 12,
  "items": [ ... ]
}
```

### `GET /management/agent_logs/latest`

Returns the latest N log records across every agent and severity, newest first.

| Query param | Type    | Default | Description                                       |
| ----------- | ------- | ------- | ------------------------------------------------- |
| `limit`     | integer | `100`   | Max records to return. Pass `-1` to return all.   |

Example:

```
GET /management/agent_logs/latest?limit=50
```

```json
{
  "count": 50,
  "items": [ ... ]
}
```

### `POST /management/agent_logs/cleanup/trigger`

Forces an immediate retention sweep (drops anything older than 14 days).

```json
{ "deleted": 42, "max_age_days": 14 }
```

## Limit semantics

For every listing endpoint:

- `limit > 0` → return at most `limit` records.
- `limit = -1` → return all matching records.
- `limit` omitted → defaults to `100`.

Listing endpoints are **not paginated**; callers expecting more than the
default should pass an explicit `limit`.

## Retention

A background job sweeps the tree at startup and every 6 hours, deleting
records whose `timestamp` is older than 14 days. The sweep is also exposed as
`POST /management/agent_logs/cleanup/trigger` for ops use. Each run writes a
`bg / agent-logs-cleanup-job` entry into the service log stream.
