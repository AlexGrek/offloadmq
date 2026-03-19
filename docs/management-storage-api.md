# Management Storage API

Administrative endpoints for inspecting and managing file buckets across all client API keys.

**Base path:** `/management/storage`
**Authentication:** `Authorization: Bearer <management_token>` (same token as all other management endpoints)

---

## Endpoints

### List All Buckets

```
GET /management/storage/buckets
```

Returns all buckets grouped by their owning client API key. Each group includes aggregate totals and a per-bucket summary.

**Response**

```json
{
  "buckets_by_key": {
    "<api_key>": {
      "bucket_count": 2,
      "total_files": 5,
      "total_bytes": 20480,
      "buckets": [
        {
          "bucket_uid": "550e8400-e29b-41d4-a716-446655440000",
          "created_at": "2026-03-17T10:00:00Z",
          "file_count": 3,
          "used_bytes": 12288
        },
        {
          "bucket_uid": "660f9511-f30c-52e5-b827-557766551111",
          "created_at": "2026-03-17T11:30:00Z",
          "file_count": 2,
          "used_bytes": 8192
        }
      ]
    }
  }
}
```

---

### Get Quotas and Usage

```
GET /management/storage/quotas
GET /management/storage/quotas?api_key=<api_key>
```

Returns the system-wide quota limits alongside per-key usage statistics. Optionally filter to a single API key with the `api_key` query parameter.

**Query parameters**

| Parameter | Type   | Required | Description                              |
|-----------|--------|----------|------------------------------------------|
| `api_key` | string | No       | Filter usage report to one API key only  |

**Response**

```json
{
  "limits": {
    "max_buckets_per_key": 256,
    "bucket_size_bytes": 1073741824,
    "bucket_ttl_minutes": 1440
  },
  "usage": {
    "<api_key>": {
      "bucket_count": 2,
      "total_bytes": 20480,
      "total_files": 5
    }
  }
}
```

> The `limits` block reflects the server configuration (`STORAGE_MAX_BUCKETS_PER_KEY`, `STORAGE_BUCKET_SIZE_BYTES`, `STORAGE_BUCKET_TTL_MINUTES`). The `usage` block contains one entry per key that owns at least one bucket, or exactly one entry when `api_key` is specified (empty map if the key has no buckets).

---

### Delete a Bucket

```
DELETE /management/storage/bucket/{bucket_uid}
```

Deletes a single bucket regardless of which client API key owns it. Removes all files from the storage backend and clears the bucket metadata from the database.

**Path parameters**

| Parameter   | Type   | Description              |
|-------------|--------|--------------------------|
| `bucket_uid` | string | UID of the bucket to delete |

**Response**

```json
{
  "deleted_bucket_uid": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Error responses**

| Status | Reason                        |
|--------|-------------------------------|
| `404`  | Bucket not found              |

---

### Delete All Buckets for a Key

```
DELETE /management/storage/key/{api_key}/buckets
```

Deletes every bucket owned by the specified client API key. Useful for cleaning up after a key is revoked or for resetting a tenant's storage.

**Path parameters**

| Parameter | Type   | Description                             |
|-----------|--------|-----------------------------------------|
| `api_key` | string | The client API key whose buckets to delete |

**Response**

```json
{
  "api_key": "my-client-key",
  "deleted_count": 3
}
```

> Returns `deleted_count: 0` (not an error) if the key has no buckets.

---

### Purge All Buckets

```
DELETE /management/storage/buckets
```

Deletes every bucket across all client API keys. This is a destructive, irreversible operation — all staged files are permanently removed from the storage backend.

**Response**

```json
{
  "deleted_count": 15
}
```

> Partial failures (e.g. a file that cannot be removed from the storage backend) are logged as warnings but do not abort the operation. The database metadata is always cleaned up even if the underlying file deletion fails.

---

## Notes

- **Storage backend agnostic** — all delete operations go through the configured OpenDAL backend (`local`, `webdav`, or `s3`).
- **Both layers cleaned up** — every delete removes files from the storage backend *and* the bucket metadata (both `buckets` and `owner_idx` trees in Sled).
- **TTL-based cleanup still runs** — the background worker that purges expired buckets every 3 hours is unaffected by these endpoints.
- **No ownership check** — unlike the client-facing storage API, management endpoints bypass API key ownership checks and can operate on any bucket.
