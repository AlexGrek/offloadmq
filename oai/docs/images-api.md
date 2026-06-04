# OAI Image Upload & Download API

REST API for user-owned image blobs in the OAI backend (`oai/backend`). Used by the image generation UI (img2img inputs, job outputs) and the read-only file browser.

All routes below require authentication unless noted. Base URL is the OAI server (e.g. `http://localhost:3000` in dev, `https://oai.alexgr.space` in production).

---

## Authentication

Send the JWT from `POST /api/auth/login` or `POST /api/auth/register` on every request.

| Method | Header / parameter | Example |
|--------|-------------------|---------|
| Preferred | `Authorization: Bearer <jwt>` | `Authorization: Bearer eyJhbG…` |
| Browser `<img>` / links | Query `?token=<jwt>` | `/api/images/files/123?token=eyJhbG…` |
| Cookie (optional) | `token=<jwt>` or `jwt=<jwt>` | Set by some clients |

Missing or invalid tokens return **401** with JSON:

```json
{ "error": "Unauthorized" }
```

Image file endpoints accept the query token because browsers do not send `Authorization` on `<img src>`.

---

## Image processing (server-side)

Every stored image is normalized on ingest (upload or OffloadMQ output download) via **libvips** (`rs-vips` crate). libvips processes images in tiles/strips rather than loading the full decoded pixel buffer into RAM, preventing OOM kills on large inputs (e.g. 48 MP camera shots).

| Rule | Value |
|------|--------|
| Output format | JPEG (`image/jpeg`) |
| JPEG quality | 90 |
| Max edge (full image) | 1920 px (downscale if larger) |
| EXIF orientation | Baked into pixels via `vips_autorot`; EXIF stripped from output |
| Thumbnail | Always created; max edge 384 px, JPEG quality 90 |

All inputs (JPEG, PNG, WebP, …) are decoded and re-encoded through libvips. The EXIF orientation transform is always applied to the pixel data and the orientation tag is removed from the output, so no viewer needs to apply a rotation to display the file correctly.

**Generated outputs** (OffloadMQ download path) are normalized the same way, then the job **prompt** is written to EXIF `ImageDescription` (UTF-8, truncated to 2000 characters). User uploads do not get prompt metadata.

**On download**, `GET /api/images/files/{id}` returns JPEG bytes. Legacy non-JPEG blobs in storage are transcoded on read.

**Storage layout** (OpenDAL; FS or S3/Garage):

| Blob | Path pattern |
|------|----------------|
| Input upload | `users/{user_id}/images/input/{image_id}.jpg` |
| Job output | `users/{user_id}/images/output/{job_id}/{image_id}.jpg` |
| Thumbnail | `users/{user_id}/images/thumbnails/{image_id}.jpg` |

Thumbnails are deleted together with the main file when storage is purged. User quota (`users.used_storage_bytes`) counts main + thumbnail bytes.

**Prerequisite:** `STORAGE_BACKEND` must be `fs` or `s3`. If storage is disabled, upload returns **400** with a message to configure storage.

---

## Upload input image

Stage a file for **img2img**, image analysis, or general user storage. Returns a snowflake `image_id` referenced as `input_image_id` when starting a job.

Uploads are always normalized by OAI before storage: the longest edge is capped at 1920 px, even if a later job also supplies OffloadMQ `dataPreparation` to shrink the file further for a specific model.

```
POST /api/images/upload
Content-Type: multipart/form-data
Authorization: Bearer <jwt>
```

### Request body

| Part | Name | Required | Description |
|------|------|----------|-------------|
| File field | `file` | Yes | Image bytes |

Optional metadata from the multipart part:

- `filename` — stored for display (default `upload.jpg`)
- `Content-Type` on the part — hint for decode (`image/png`, `image/jpeg`, …)

### Limits

- Maximum raw body size: **32 MiB** (multipart total; matches server `DefaultBodyLimit`)
- Empty file → **400** `empty image`
- Oversize → **400** `image exceeds 32MB limit`
- Missing `file` field → **400** `missing multipart field 'file'`

### Response — **201 Created**

```json
{
  "image_id": "18446744073709551616",
  "filename": "photo.png",
  "content_type": "image/jpeg",
  "width": 1024,
  "height": 768,
  "size_bytes": 245120,
  "rescaled": false,
  "reencoded": true
}
```

| Field | Description |
|-------|-------------|
| `image_id` | Stable id for download URLs and `input_image_id` on job submit |
| `content_type` | Always `image/jpeg` after processing |
| `width` / `height` | Stored dimensions after orientation + rescale |
| `size_bytes` | Stored main JPEG size (thumbnail stored separately) |
| `rescaled` | `true` if longest edge was reduced to 1920 |
| `reencoded` | Always `true` — all images are normalized through libvips |

### Example

```bash
curl -sS -X POST "$OAI/api/images/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/photo.png;type=image/png"
```

---

## Download full image

```
GET /api/images/files/{image_id}
Authorization: Bearer <jwt>
```

Or for HTML:

```
GET /api/images/files/{image_id}?token=<jwt>
```

### Path parameters

| Name | Type | Description |
|------|------|-------------|
| `image_id` | int64 string | From upload response, job `files[]`, or poll `output_images[]` |

### Response — **200 OK**

- **Body:** raw JPEG bytes
- **Header:** `Content-Type: image/jpeg`

### Errors

| Status | When |
|--------|------|
| 401 | Not authenticated |
| 404 | Unknown id or file owned by another user |
| 400 | Storage disabled |
| 500 | Storage read failure |

JSON error body on failure (not image bytes):

```json
{ "error": "Not found" }
```

### Example

```bash
curl -sS -o out.jpg \
  -H "Authorization: Bearer $TOKEN" \
  "$OAI/api/images/files/18446744073709551616"
```

---

## Download thumbnail

Small JPEG for lists, sidebars, and previews. Created at upload/output time; older rows may generate a thumbnail on first request.

```
GET /api/images/files/{image_id}/thumbnail
Authorization: Bearer <jwt>
```

Query `?token=` is supported the same as the full image endpoint.

### Response — **200 OK**

- **Body:** JPEG thumbnail (max edge 384 px)
- **Content-Type:** `image/jpeg`

Same ownership and error rules as the full image endpoint.

---

## Starred copies

Favorites are stored as a copy of the main JPEG under `users/{user_id}/images/starred/{image_id}.jpg` in the OAI pod storage backend (no DB column). Starred state is determined by checking whether that path exists.

```
GET /api/images/files/{image_id}/starred
PATCH /api/images/files/{image_id}/starred
Authorization: Bearer <jwt>
```

### GET response — **200 OK**

```json
{ "starred": true }
```

### PATCH body

```json
{ "starred": true }
```

### PATCH response — **200 OK**

```json
{ "starred": true }
```

Set `starred: false` to remove the copy from the starred directory.

---

## Delete generated output

Removes the DB row and storage blobs (main image + thumbnail + starred copy if present). Only **`direction: "output"`** images can be deleted.

```
DELETE /api/images/files/{image_id}
Authorization: Bearer <jwt>
```

### Response — **204 No Content**

### Errors

| Status | When |
|--------|------|
| 400 | File is an input/upload (not generated output) |
| 404 | Unknown id or not owned by user |

### Example

```bash
curl -sS -o thumb.jpg \
  "$OAI/api/images/files/18446744073709551616/thumbnail?token=$TOKEN"
```

---

## List files (metadata + URLs)

Read-only catalog of the caller’s images. Does not return bytes; use the download endpoints above.

```
GET /api/files
Authorization: Bearer <jwt>
```

### Response — **200 OK**

```json
{
  "files": [
    {
      "id": "18446744073709551616",
      "direction": "input",
      "source": "upload",
      "filename": "photo.png",
      "content_type": "image/jpeg",
      "width": 1024,
      "height": 768,
      "size_bytes": 245120,
      "sha256": "abc123…",
      "job_id": null,
      "created_at": "2026-05-22T12:00:00+00:00",
      "url": "/api/images/files/18446744073709551616",
      "thumbnail_url": "/api/images/files/18446744073709551616/thumbnail",
      "is_image": true
    }
  ],
  "summary": {
    "used_bytes": 512000,
    "file_count": 3,
    "input_bytes": 300000,
    "output_bytes": 212000
  }
}
```

| Field | Description |
|-------|-------------|
| `direction` | `input` or `output` |
| `source` | `upload` or `offload_download` |
| `url` | Relative path to full image; append `?token=` for `<img>` if needed |
| `thumbnail_url` | Relative path to thumbnail JPEG (use for grid previews) |
| `summary.used_bytes` | Cached total (main + thumbnails) for the user |

The OAI file browser loads `thumbnail_url` in tiles and opens the full `url` in the lightbox.

Maximum **500** files per request (newest first). There is no delete endpoint on this surface.

---

## How outputs get an `image_id`

Upload covers **inputs**. **Generated** images are not uploaded by the client; the server downloads them from OffloadMQ after a job completes and stores them like uploads (main JPEG + thumbnail).

Typical client flow:

1. `POST /api/images/upload` → `image_id` (img2img only)
2. `POST /api/images/jobs` with `input_image_id` when needed
3. `POST /api/images/jobs/{job_id}/poll` until `status` is terminal
4. Read `output_images[].image_id` or `GET /api/images/jobs/{job_id}` → `files[]` where `direction == "output"`
5. `GET /api/images/files/{image_id}` or `…/thumbnail` to display

Poll response excerpt:

```json
{
  "job_id": "18446744073709551617",
  "status": "completed",
  "stage": null,
  "error": null,
  "output_images": [
    {
      "image_id": "18446744073709551618",
      "filename": "output_1.jpg",
      "width": 1024,
      "height": 1024,
      "content_type": "image/jpeg",
      "size_bytes": 198000
    }
  ]
}
```

Job list/detail, capabilities, poll, and cancel are separate job APIs (same `/api/images/*` prefix). See the OAI frontend client in `oai/frontend/src/api/images.ts` for request shapes.

---

## Error format (JSON endpoints)

Upload and metadata routes return errors as:

```json
{ "error": "<message>" }
```

| HTTP status | Meaning |
|-------------|---------|
| 400 | Validation, storage disabled, bad multipart |
| 401 | Auth missing/invalid |
| 404 | Resource not found (wrong user or id) |
| 502 | OffloadMQ / external failure (job paths) |
| 500 | Internal or database error |

---

## Configuration

| Variable | Role |
|----------|------|
| `STORAGE_BACKEND` | `fs` (dev) or `s3` (prod); `none` disables uploads |
| `STORAGE_FS_ROOT` | Local root when `fs` (default `./.data/storage`) |
| `STORAGE_S3_*` | S3/Garage endpoint, bucket, credentials when `s3` |
| `JWT_SECRET` | Signs user tokens used by these routes |

---

## Implementation reference

| Area | Location |
|------|----------|
| Routes | `oai/backend/src/routes/images.rs`, `routes/files.rs` |
| Upload / download logic | `oai/backend/src/services/image_jobs.rs` |
| JPEG + thumbnail processing | `oai/backend/src/services/image_processing.rs` |
| Storage paths | `oai/backend/src/services/image_paths.rs` |
| Route registration | `oai/backend/src/app.rs` |
