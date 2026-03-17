# Client Storage API

File bucket API for staging files alongside task submissions. Clients can create temporary buckets, upload files, and retrieve file metadata.

**Base path:** `/api/storage`
**Authentication:** `X-API-Key: <your-client-api-key>` header

---

## Overview

Clients can create up to 10 buckets (configurable) to stage files. Each bucket has:
- **Max size:** 1 GiB per bucket (configurable via `STORAGE_BUCKET_SIZE_BYTES`)
- **TTL:** 24 hours (configurable via `STORAGE_BUCKET_TTL_MINUTES`)
- **Backend:** Local filesystem, WebDAV, or S3 (configurable via `STORAGE_BACKEND`)

Files are **not downloadable** — the API provides SHA-256 digests and metadata only. This is intentional to prevent use as a general file exchange service.

---

## Endpoints

### Get Account Limits

```
GET /api/storage/limits
```

Returns quota limits for your API key.

**Response**

```json
{
  "max_buckets": 10,
  "bucket_size_bytes": 1073741824,
  "bucket_ttl_minutes": 1440
}
```

---

### List Your Buckets

```
GET /api/storage/buckets
```

Returns all buckets owned by your API key with usage information.

**Response**

```json
{
  "buckets": [
    {
      "bucket_uid": "550e8400-e29b-41d4-a716-446655440000",
      "created_at": "2026-03-17T10:00:00Z",
      "file_count": 3,
      "used_bytes": 12288,
      "remaining_bytes": 1073729536,
      "tasks": []
    },
    {
      "bucket_uid": "660f9511-f30c-52e5-b827-557766551111",
      "created_at": "2026-03-17T11:30:00Z",
      "file_count": 2,
      "used_bytes": 8192,
      "remaining_bytes": 1073733632,
      "tasks": ["task-001", "task-002"]
    }
  ]
}
```

| Field            | Description                                                        |
|------------------|--------------------------------------------------------------------|
| `bucket_uid`     | Unique identifier for the bucket (UUID)                            |
| `created_at`     | ISO 8601 timestamp when bucket was created                         |
| `file_count`     | Number of files currently in the bucket                            |
| `used_bytes`     | Total bytes consumed by files in this bucket                       |
| `remaining_bytes`| Bytes remaining before bucket reaches size limit                   |
| `tasks`          | List of task IDs associated with files in this bucket (if any)    |

---

### Create a Bucket

```
POST /api/storage/bucket/create
```

Creates a new bucket. Returns a unique `bucket_uid` for subsequent file operations.

**Request body**

```json
{}
```

(No fields required — the bucket is scoped to your API key automatically)

**Response** (201 Created)

```json
{
  "bucket_uid": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Error responses**

| Status | Reason                              |
|--------|-------------------------------------|
| `400`  | Bucket limit reached (max 10)       |
| `500`  | Server error creating bucket        |

---

### Upload a File

```
POST /api/storage/bucket/{bucket_uid}/upload
Content-Type: multipart/form-data
```

Uploads a file to an existing bucket. The SHA-256 digest is computed and stored automatically.

**Path parameters**

| Parameter    | Type   | Description        |
|--------------|--------|--------------------|
| `bucket_uid` | string | Target bucket UID  |

**Form fields**

| Field  | Type | Required | Description         |
|--------|------|----------|----------------------|
| `file` | file | Yes      | File to upload       |

**Response** (201 Created)

```json
{
  "file_uid": "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
  "size_bytes": 4096,
  "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

| Field       | Description                                    |
|-------------|------------------------------------------------|
| `file_uid`  | Unique identifier for the uploaded file (UUID) |
| `size_bytes`| Size of the uploaded file in bytes              |
| `hash`      | SHA-256 digest of the file                      |

**Error responses**

| Status | Reason                                    |
|--------|-------------------------------------------|
| `404`  | Bucket not found (wrong UID or expired)   |
| `413`  | File too large (bucket would exceed limit)|
| `500`  | Server error uploading file               |

---

### Get Bucket Contents

```
GET /api/storage/bucket/{bucket_uid}/stat
```

Lists all files in a bucket along with remaining space.

**Path parameters**

| Parameter    | Type   | Description        |
|--------------|--------|--------------------|
| `bucket_uid` | string | Target bucket UID  |

**Response**

```json
{
  "files": [
    {
      "file_uid": "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
      "size_bytes": 4096
    },
    {
      "file_uid": "b2c3d4e5-f6a7-58h9-i0j1-k2l3m4n5o6p7",
      "size_bytes": 8192
    }
  ],
  "used_bytes": 12288,
  "remaining_bytes": 1073729536
}
```

| Field            | Description                              |
|------------------|------------------------------------------|
| `files`          | Array of files in the bucket             |
| `file_uid`       | Unique identifier for each file (UUID)   |
| `size_bytes`     | Size of each file in bytes               |
| `used_bytes`     | Total bytes consumed in bucket           |
| `remaining_bytes`| Bytes available before size limit        |

**Error responses**

| Status | Reason                              |
|--------|-------------------------------------|
| `404`  | Bucket not found (wrong UID or expired) |

---

### Get File Hash

```
GET /api/storage/bucket/{bucket_uid}/file/{file_uid}/hash
```

Retrieves the SHA-256 digest of a file. No file download — digest only.

**Path parameters**

| Parameter    | Type   | Description         |
|--------------|--------|---------------------|
| `bucket_uid` | string | Bucket UID          |
| `file_uid`   | string | File UID            |

**Response**

```json
{
  "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

**Error responses**

| Status | Reason                           |
|--------|----------------------------------|
| `404`  | Bucket or file not found         |

---

### Delete a File

```
DELETE /api/storage/bucket/{bucket_uid}/file/{file_uid}
```

Removes a single file from a bucket and frees up space.

**Path parameters**

| Parameter    | Type   | Description         |
|--------------|--------|---------------------|
| `bucket_uid` | string | Bucket UID          |
| `file_uid`   | string | File UID to delete  |

**Response**

```json
{
  "deleted_file_uid": "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6"
}
```

**Error responses**

| Status | Reason                           |
|--------|----------------------------------|
| `404`  | Bucket or file not found         |

---

### Delete a Bucket

```
DELETE /api/storage/bucket/{bucket_uid}
```

Deletes an entire bucket and all its files. Cannot be undone.

**Path parameters**

| Parameter    | Type   | Description              |
|--------------|--------|--------------------------|
| `bucket_uid` | string | Bucket UID to delete     |

**Response**

```json
{
  "deleted_bucket_uid": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Error responses**

| Status | Reason                                    |
|--------|-------------------------------------------|
| `404`  | Bucket not found (wrong UID or expired)   |

---

## Examples

### Python

```python
import requests

BASE = "http://localhost:3069"
API_KEY = "my-client-key"
headers = {"X-API-Key": API_KEY}

# Create a bucket
r = requests.post(f"{BASE}/api/storage/bucket/create", headers=headers)
bucket_uid = r.json()["bucket_uid"]

# Upload a file
with open("model.onnx", "rb") as f:
    files = {"file": f}
    r = requests.post(
        f"{BASE}/api/storage/bucket/{bucket_uid}/upload",
        headers=headers,
        files=files
    )
file_uid = r.json()["file_uid"]
file_hash = r.json()["hash"]

# List bucket contents
r = requests.get(f"{BASE}/api/storage/bucket/{bucket_uid}/stat", headers=headers)
print(r.json())

# Get file hash
r = requests.get(
    f"{BASE}/api/storage/bucket/{bucket_uid}/file/{file_uid}/hash",
    headers=headers
)
print(f"File hash: {r.json()['hash']}")

# Delete file
requests.delete(
    f"{BASE}/api/storage/bucket/{bucket_uid}/file/{file_uid}",
    headers=headers
)

# Delete bucket
requests.delete(
    f"{BASE}/api/storage/bucket/{bucket_uid}",
    headers=headers
)
```

### cURL

```bash
API_KEY="my-client-key"
BASE="http://localhost:3069"

# Create bucket
BUCKET=$(curl -s -X POST "$BASE/api/storage/bucket/create" \
  -H "X-API-Key: $API_KEY" | jq -r '.bucket_uid')

# Upload file
RESPONSE=$(curl -s -X POST "$BASE/api/storage/bucket/$BUCKET/upload" \
  -H "X-API-Key: $API_KEY" \
  -F "file=@./model.onnx")
FILE_UID=$(echo $RESPONSE | jq -r '.file_uid')

# Get bucket stat
curl -s -X GET "$BASE/api/storage/bucket/$BUCKET/stat" \
  -H "X-API-Key: $API_KEY" | jq .

# Get file hash
curl -s -X GET "$BASE/api/storage/bucket/$BUCKET/file/$FILE_UID/hash" \
  -H "X-API-Key: $API_KEY" | jq .

# Delete file
curl -s -X DELETE "$BASE/api/storage/bucket/$BUCKET/file/$FILE_UID" \
  -H "X-API-Key: $API_KEY"

# Delete bucket
curl -s -X DELETE "$BASE/api/storage/bucket/$BUCKET" \
  -H "X-API-Key: $API_KEY"
```

---

## Notes

- **Ownership enforcement** — every request validates that the bucket belongs to your API key
- **TTL expiration** — buckets are automatically deleted 24 hours after creation (configurable)
- **No downloads** — use the hash to verify files before submitting tasks, but files cannot be downloaded via the API
- **Storage backends** — files are stored in the configured location (local filesystem, WebDAV, or S3) transparently
- **Cleanup** — a background worker runs every 3 hours to delete expired buckets and their associated files
