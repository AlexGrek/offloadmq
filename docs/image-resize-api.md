# image_resize API Contract

Payload contract between clients and agents for `image_resize` tasks — plain Pillow
image rescaling. The server is transparent to task payloads; it routes by capability
string and passes the payload through unchanged.

Unlike [`img-utils`](img-utils-api.md), `image_resize` has **no external runtime**:
Pillow is a hard dependency of the agent, so the capability is always detected and
**every agent advertises it by default**. It is the capability to use when all you need
is different pixel dimensions — no GPU node is occupied, and no workflow has to be
installed.

---

## Capability Naming

```
image_resize[<method>;<method>;...]
```

The capability has no sub-name — there is one implementation, and the variation lives
in the extended attributes, which list the resampling filters the agent supports:

**Agents register:**
```
image_resize[nearest;box;bilinear;hamming;bicubic;lanczos]
```

**Clients submit the base capability only (no brackets):**
```
image_resize
```

### Enabling / disabling on an agent

It is a **regular (opt-out)** capability: enabled unless the operator turns it off.
Uncheck it on the agent web UI's **Capabilities** page, or add it to
`regular_disabled_caps` in `.offloadmq-agent.json`:

```json
{ "regular_disabled_caps": ["image_resize[nearest;box;bilinear;hamming;bicubic;lanczos]"] }
```

---

## Client → Agent Payload

Submitted as the `payload` field of `POST /api/task/submit`.

```json
{
  "input_image": "photo.jpg",
  "method":      "lanczos",
  "mode":        "fit",
  "width":       1024,
  "height":      1024,
  "format":      "webp",
  "quality":     90
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `input_image` | string \| string[] | No | Filename(s) in the linked file bucket. **Omit to resize every image in the bucket.** (`input_images` is accepted as an alias.) |
| `method` | string | No | Resampling filter. One of the capability's extended attributes. Default `lanczos`. |
| `mode` | string | No | `fit` (default), `exact`, or `cover` — see below. |
| `width` | integer | Conditional | Target width. |
| `height` | integer | Conditional | Target height. |
| `scale` | number | Conditional | Multiply both dimensions by this factor. Overrides `width`/`height`/`mode`. |
| `allow_upscale` | boolean | No | `mode=fit` only. Default `true`; set `false` to leave images that are already smaller than the box untouched. |
| `format` | string | No | Output format: `png`, `jpeg`/`jpg`, `webp`, `bmp`, `tiff`, `gif`. Defaults to the input's format (PNG if that is unrecognised). |
| `quality` | integer 1–100 | No | JPEG/WebP encoder quality. Ignored by lossless formats. |

Supply **either** `scale`, **or** at least one of `width`/`height` — a payload with
neither is rejected.

### Resize modes

| Mode | Aspect ratio | Needs | Result |
|------|--------------|-------|--------|
| `fit` (default) | preserved | `width` and/or `height` | Largest size that fits inside the box. With one dimension given, the other follows the aspect ratio. |
| `exact` | ignored | both | Stretched to exactly `width` × `height`. |
| `cover` | preserved | both | Fills the box and centre-crops the overflow. |

`scale` bypasses the modes entirely: both dimensions are multiplied by the factor and
rounded, with a floor of 1 px.

EXIF orientation is applied before any geometry, so the output matches what a viewer
shows rather than the raw pixel layout.

### File references

Work exactly as in [comfy-api.md](comfy-api.md#file-references): upload to a bucket, pass
the bucket UID in `file_bucket`, and reference files by name. `output_bucket` is
**required** — `image_resize` never returns base64.

---

## Agent → Client Output

One `images` array of bucket references, plus the resolved dimensions of each file:

```json
{
  "method":        "lanczos",
  "mode":          "fit",
  "image_count":   1,
  "output_bucket": "550e8400-e29b-41d4-a716-446655440000",
  "images": [
    {
      "filename":        "photo.webp",
      "content_type":    "image/webp",
      "file_uid":        "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
      "bucket_uid":      "550e8400-e29b-41d4-a716-446655440000",
      "width":           1024,
      "height":          683,
      "original_width":  4000,
      "original_height": 2667
    }
  ]
}
```

Output filenames keep the input's stem and take the extension of the output format.
Download results via `GET /api/storage/bucket/{bucket_uid}/file/{file_uid}`.

On failure the task resolves with `{"error": "<message>"}` — bad `method`, `mode` or
`format` values name the supported set in the message.

---

## Example — fit a photo inside 1024×1024 as WebP

```python
import requests

BASE = "http://localhost:3069"
KEY  = "client_secret_key_123"
hdrs = {"X-API-Key": KEY}

in_bucket  = requests.post(f"{BASE}/api/storage/bucket/create", headers=hdrs).json()["bucket_uid"]
out_bucket = requests.post(f"{BASE}/api/storage/bucket/create", headers=hdrs).json()["bucket_uid"]

with open("photo.jpg", "rb") as f:
    requests.post(
        f"{BASE}/api/storage/bucket/{in_bucket}/upload",
        headers=hdrs,
        files={"file": ("photo.jpg", f, "image/jpeg")},
    )

task = requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":        KEY,
    "capability":    "image_resize",
    "file_bucket":   [in_bucket],
    "output_bucket": out_bucket,
    "payload": {
        "input_image": "photo.jpg",
        "width":  1024,
        "height": 1024,
        "format": "webp",
        "quality": 90,
    },
}).json()["id"]
```

## Example — square thumbnails for every image in a bucket

```python
requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":        KEY,
    "capability":    "image_resize",
    "file_bucket":   [in_bucket],
    "output_bucket": out_bucket,
    "payload": {"mode": "cover", "width": 256, "height": 256, "method": "lanczos"},
})
```

## Example — halve the resolution, keep the format

```python
requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":        KEY,
    "capability":    "image_resize",
    "file_bucket":   [in_bucket],
    "output_bucket": out_bucket,
    "payload": {"scale": 0.5},
})
```

---

## Implementation

Agent side: [`agent_v2/agent/src/offloadmq_agent/exec/image_resize.py`](../agent_v2/agent/src/offloadmq_agent/exec/image_resize.py).
It runs through the routed pipeline, so bucket download, `dataPreparation`, progress
reporting and cancellation all behave as they do for the ComfyUI families. Each uploaded
file emits a progress line, which doubles as the cancellation checkpoint on multi-image
batches.

Adding a resampling filter is a one-line change: append it to `RESAMPLING_METHODS`. The
registration string, the payload validator and the tests all read that tuple.
