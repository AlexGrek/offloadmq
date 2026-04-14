# OffloadMQ ONNX Nude Detection Integration Guide

This document is a standalone, end-to-end guide for integrating the `onnx.nudenet` capability into your app.

It covers:

1. Client authentication with API keys
2. Required Storage API endpoints + request/response models
3. ONNX task endpoints and models (urgent + async)
4. Polling flow for non-urgent tasks
5. Expected errors and how to handle them
6. Online capability discovery and why you should use it

---

## 1) Authentication for Clients (API Keys)

OffloadMQ client integrations use **one client API key** for both task submission and storage.

### Task API auth (`/api/*`)

- Send `apiKey` in the JSON body.
- Do **not** use `Authorization` for normal client task calls.

Example:

```json
{
  "apiKey": "client_secret_key_123",
  "capability": "onnx.nudenet",
  "urgent": true,
  "payload": { "threshold": 0.25 }
}
```

### Storage API auth (`/api/storage/*`)

- Send `X-API-Key: <client-key>` header.
- Most storage endpoints have no JSON body.

Example:

```http
GET /api/storage/limits
X-API-Key: client_secret_key_123
```

---

## 2) Required Storage API Endpoints (for image input)

`onnx.nudenet` expects images to be present in task input files. The standard client pattern is:

1. Create a bucket
2. Upload one or more images
3. Submit task with `file_bucket: [bucket_uid]`
4. Delete bucket after completion (or create with `rm_after_task=true`)

### 2.1 Get limits

`GET /api/storage/limits`

Headers:

- `X-API-Key: <client-key>`

Response model:

```json
{
  "max_buckets_per_key": 256,
  "bucket_size_bytes": 1073741824,
  "bucket_ttl_minutes": 1440
}
```

### 2.2 Create bucket

`POST /api/storage/bucket/create`

Headers:

- `X-API-Key: <client-key>`

Optional query:

- `?rm_after_task=true` (auto-delete after first linked task completes)

Response model (201):

```json
{
  "bucket_uid": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-04-14T12:00:00Z",
  "rm_after_task": false
}
```

### 2.3 Upload file

`POST /api/storage/bucket/{bucket_uid}/upload`

Headers:

- `X-API-Key: <client-key>`

Body:

- `multipart/form-data`
- field name **must** be `file`

Response model (201):

```json
{
  "file_uid": "a3bb189e-8bf9-3888-9912-ace4e6543002",
  "original_name": "photo.jpg",
  "size": 204800,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

### 2.4 Inspect bucket (optional but useful)

`GET /api/storage/bucket/{bucket_uid}/stat`

Headers:

- `X-API-Key: <client-key>`

Response model:

```json
{
  "bucket_uid": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-04-14T12:00:00Z",
  "used_bytes": 204800,
  "capacity_bytes": 1073741824,
  "remaining_bytes": 1073536024,
  "file_count": 1,
  "rm_after_task": false,
  "files": [
    {
      "file_uid": "a3bb189e-8bf9-3888-9912-ace4e6543002",
      "original_name": "photo.jpg",
      "size": 204800,
      "uploaded_at": "2026-04-14T12:00:05Z"
    }
  ]
}
```

### 2.5 Delete bucket

`DELETE /api/storage/bucket/{bucket_uid}`

Headers:

- `X-API-Key: <client-key>`

Response model:

```json
{ "deleted_bucket_uid": "550e8400-e29b-41d4-a716-446655440000" }
```

---

## 3) ONNX Capability Endpoint + Request/Response Models

Capability string for nude detection:

- `onnx.nudenet`

The task payload supports:

- `threshold` (float, optional, default `0.25`)

The detector reads image files from `file_bucket` and returns per-image detections with labels, confidence, and bounding boxes.

### 3.1 Urgent (blocking) request

Endpoint:

- `POST /api/task/submit_blocking`

Important:

- `urgent` **must be true** on this endpoint.

Request model:

```json
{
  "apiKey": "client_secret_key_123",
  "capability": "onnx.nudenet",
  "urgent": true,
  "restartable": false,
  "payload": {
    "threshold": 0.25
  },
  "fetchFiles": [],
  "file_bucket": ["550e8400-e29b-41d4-a716-446655440000"],
  "artifacts": []
}
```

Success response shape (task completed):

```json
{
  "id": { "cap": "onnx.nudenet", "id": "01ARZ3NDE4V2XTGZUVY7" },
  "status": "completed",
  "result": {
    "model": "nudenet",
    "threshold": 0.25,
    "images_processed": 2,
    "results": [
      {
        "file": "photo1.jpg",
        "detection_count": 3,
        "detections": [
          {
            "label": "FEMALE_BREAST_EXPOSED",
            "confidence": 0.9132,
            "box": { "x1": 100.2, "y1": 80.1, "x2": 244.7, "y2": 290.9 }
          }
        ]
      },
      {
        "file": "photo2.jpg",
        "detection_count": 0,
        "detections": []
      }
    ]
  },
  "log": "..."
}
```

### 3.2 Async (non-urgent) request

Endpoint:

- `POST /api/task/submit`

Request model (recommended for image batches):

```json
{
  "apiKey": "client_secret_key_123",
  "capability": "onnx.nudenet",
  "urgent": false,
  "restartable": false,
  "payload": {
    "threshold": 0.3
  },
  "fetchFiles": [],
  "file_bucket": ["550e8400-e29b-41d4-a716-446655440000"],
  "artifacts": []
}
```

Submit response:

```json
{
  "id": {
    "cap": "onnx.nudenet",
    "id": "01ARZ3NDE4V2XTGZUVY7"
  },
  "capability": "onnx.nudenet",
  "status": "queued",
  "message": "Added to tasks queue"
}
```

Store both:

- `id.cap`
- `id.id`

You need both values for polling.

---

## 4) Polling Process for Non-Urgent Tasks

Endpoint:

- `POST /api/task/poll/{cap}/{id}`

Request model:

```json
{
  "apiKey": "client_secret_key_123"
}
```

In-progress response model:

```json
{
  "id": { "cap": "onnx.nudenet", "id": "01ARZ3NDE4V2XTGZUVY7" },
  "status": "running",
  "createdAt": "2026-04-14T12:00:10Z",
  "stage": "running",
  "output": null,
  "log": "Downloading inputs...\\nRunning detector...\\n",
  "typicalRuntimeSeconds": { "secs": 8, "nanos": 0 }
}
```

Completed response model:

```json
{
  "id": { "cap": "onnx.nudenet", "id": "01ARZ3NDE4V2XTGZUVY7" },
  "status": "completed",
  "createdAt": "2026-04-14T12:00:10Z",
  "stage": null,
  "output": {
    "model": "nudenet",
    "threshold": 0.3,
    "images_processed": 2,
    "results": [
      {
        "file": "photo1.jpg",
        "detection_count": 1,
        "detections": [
          {
            "label": "FEMALE_GENITALIA_EXPOSED",
            "confidence": 0.8841,
            "box": { "x1": 120.4, "y1": 140.1, "x2": 210.6, "y2": 260.2 }
          }
        ]
      }
    ]
  },
  "log": "Done",
  "typicalRuntimeSeconds": { "secs": 8, "nanos": 0 }
}
```

### Polling algorithm

1. Submit with `POST /api/task/submit`
2. Poll every 2-3 seconds with `POST /api/task/poll/{cap}/{id}`
3. Stop when `status` is one of:
   - `completed`
   - `failed`
   - `canceled`
4. On completion, read result from `output`

---

## 5) Expected Errors

OffloadMQ error envelope:

```json
{
  "error": {
    "type": "error_type",
    "message": "Human-readable message",
    "status": 400
  }
}
```

### Common integration errors for `onnx.nudenet`

| HTTP | Type | Cause | Fix |
|---|---|---|---|
| `401` | `authentication_error` | Invalid/missing client API key | Use a valid key |
| `403` | `authorization_error` | Key not allowed to use `onnx.nudenet` or bucket not owned by key | Update key permissions / bucket ownership |
| `404` | `not_found` | Wrong task ID, bucket UID, or file UID | Verify IDs and lifecycle |
| `409` | `conflict` | Cancellation conflict or terminal task state | Treat as terminal, stop retries |
| `503` | `scheduling impossible` | No online agent currently advertising `onnx.nudenet` | Use capability discovery + retry with backoff |
| `400` | `bad_request` | Invalid payload shape or `urgent != true` on `/submit_blocking` | Fix request body |

### Agent-side failure surfaced in task result

A task can return HTTP 200 but still fail logically (`status: "failed"`). For ONNX, common agent errors include:

- ONNX model not installed on runner
- `onnxruntime` missing on runner
- No images found in input bucket
- Corrupt/unsupported image

Example failed poll response:

```json
{
  "id": { "cap": "onnx.nudenet", "id": "01ARZ3NDE4V2XTGZUVY7" },
  "status": "failed",
  "output": {
    "error": "NudeNet model not installed. Use slavemode.onnx-models-prepare or CLI 'onnx prepare nudenet'"
  },
  "log": "..."
}
```

Your app should treat `status=failed` as terminal and surface `output.error`.

---

## 6) Endpoint to Find Online Capabilities (and why to use it)

Endpoint:

- `POST /api/capabilities/online`

Request model:

```json
{
  "apiKey": "client_secret_key_123"
}
```

Response model:

```json
[
  "llm.qwen3:8b",
  "onnx.nudenet",
  "shell.bash"
]
```

### Why this endpoint is critical

Use it before submit to:

1. **Prevent avoidable 503 errors** — if `onnx.nudenet` is not online, you know immediately.
2. **Respect key permissions** — response is filtered to what that API key is allowed to use.
3. **Drive UI state** — enable/disable “Run Nude Detection” based on live availability.
4. **Implement smart fallback** — if unavailable, show guidance or queue later.

### Optional extended discovery

If you need raw extended capability strings (with bracket attrs), use:

- `POST /api/capabilities/list/online_ext`

For `onnx.nudenet`, the base capability is usually enough.

---

## End-to-End cURL Example (Async)

```bash
BASE="https://mq.example.com"
API_KEY="client_secret_key_123"

# 1) Discover capabilities
curl -s -X POST "$BASE/api/capabilities/online" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$API_KEY\"}"

# 2) Create bucket
BUCKET_UID=$(curl -s -X POST "$BASE/api/storage/bucket/create" \
  -H "X-API-Key: $API_KEY" | jq -r '.bucket_uid')

# 3) Upload image(s)
curl -s -X POST "$BASE/api/storage/bucket/$BUCKET_UID/upload" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@./sample1.jpg"

curl -s -X POST "$BASE/api/storage/bucket/$BUCKET_UID/upload" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@./sample2.jpg"

# 4) Submit async ONNX task
SUBMIT=$(curl -s -X POST "$BASE/api/task/submit" \
  -H "Content-Type: application/json" \
  -d "{
    \"apiKey\":\"$API_KEY\",
    \"capability\":\"onnx.nudenet\",
    \"urgent\":false,
    \"restartable\":false,
    \"payload\":{\"threshold\":0.25},
    \"fetchFiles\":[],
    \"file_bucket\":[\"$BUCKET_UID\"],
    \"artifacts\":[]
  }")

TASK_CAP=$(echo "$SUBMIT" | jq -r '.id.cap')
TASK_ID=$(echo "$SUBMIT" | jq -r '.id.id')

# 5) Poll until terminal state
while true; do
  POLL=$(curl -s -X POST "$BASE/api/task/poll/$TASK_CAP/$TASK_ID" \
    -H "Content-Type: application/json" \
    -d "{\"apiKey\":\"$API_KEY\"}")
  STATUS=$(echo "$POLL" | jq -r '.status')
  echo "Status: $STATUS"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "canceled" ]; then
    echo "$POLL" | jq .
    break
  fi
  sleep 2
done

# 6) Cleanup
curl -s -X DELETE "$BASE/api/storage/bucket/$BUCKET_UID" \
  -H "X-API-Key: $API_KEY"
```

---

## Implementation Checklist

- [ ] Call `/api/capabilities/online` and confirm `onnx.nudenet` exists
- [ ] Create storage bucket and upload at least one image
- [ ] Submit task with `capability: "onnx.nudenet"` and `file_bucket`
- [ ] Poll until terminal state for async flows
- [ ] Parse `output.results[*].detections[*]`
- [ ] Handle `status=failed` and HTTP-level errors
- [ ] Delete bucket (or use `rm_after_task=true`)

