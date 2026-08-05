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

## OAI integration

The OAI web app exposes this as **Basic resize** under **Image Tools** (`/app/img-utils`),
alongside the `img-utils.*` transforms — same job table, same history sidebar, same
poll/cancel/retry endpoints ([img-utils-api.md](img-utils-api.md#oai-integration)). The tool
appears in the picker whenever an agent advertising `image_resize` is online, which in
practice means whenever any agent is.

Differences from an `img-utils.*` tool inside OAI:

- The job's `workflow` column holds the synthetic name `basic_resize`; nothing is sent to
  the agent under that name, since this payload has no `workflow` field.
- The resize parameters are stored (normalized) as the job's `options`, so **Retry**
  replays the same settings. For ComfyUI tools `options` becomes `secondary_prompts`; here
  the options *are* the payload.
- `width`/`height` are capped at **1920 px**, because OAI downscales every stored image to
  that on the way into `image_files` — a larger request could not be delivered. The backend
  rejects larger values (`services/image_resize.rs`) and the form caps them.
- OAI normalizes the *input* upload too (JPEG q90, ≤1920 px). Resize therefore operates on
  the stored copy, not the user's original bytes.

### "External resize" — the pre-step in img2img, img2video and Describe image

`image_resize` is also used behind the scenes, as an optional **pre-step** on jobs that
take an input image.

The reason is a gap in OAI's local processing: `process_image` deliberately *bypasses*
decode + resize for JPEGs over `MAX_TRANSCODE_BYTES` (8 MB) or `MAX_TRANSCODE_EDGE`
(6000 px), because pulling a 48 MP photo through libvips can exceed pod memory. Those
uploads are stored **verbatim, at full size** — and then shipped whole to whichever agent
runs the job, which for these three features is the expensive GPU/vision one.

Ticking **External resize** hands that downscale to a cheap `image_resize` agent instead.
Nothing is decoded in the pod, and the real task only ever downloads the small file:

```text
start_job(external_resize = true)
  → stage the raw stored bytes → submit `image_resize`     ← the job's offload task
  → poll … completed
  → promote: submit the real task with file_bucket = the resize task's output bucket
  → poll … completed → normal result handling
```

The resized image never round-trips through OAI — the pre-step's own output bucket becomes
the real task's input bucket. There is no "phase" column either: the in-flight task **is**
the pre-step exactly when its capability is `image_resize`.

| | |
|---|---|
| Checkbox | Shown only while an `image_resize` agent is online (`GET /api/images/external-resize`) |
| Default on | Stored upload larger than **9 MB** — just above the point where local processing gives up |
| Resize target | `fit` inside 1920×1920, `allow_upscale: false`, JPEG q90 — the same box `process_image` would have used |
| Replayed on | "Edit prompt", retry (imggen `pipeline_params.external_resize`, `image_analysis_jobs.external_resize`) |
| Cancel | Cancels whichever task is in flight, pre-step included |
| Not applicable | txt2img / txt2video — no input image, so the flag is ignored |

Backend: [`services/external_resize.rs`](../oai/backend/src/services/external_resize.rs)
(submit + extract), with the promote step living in each pipeline
(`image_jobs::promote_after_resize`, `image_analysis::promote_after_resize`).

---

## Implementation

Agent side: [`agent_v2/agent/src/offloadmq_agent/exec/image_resize.py`](../agent_v2/agent/src/offloadmq_agent/exec/image_resize.py).
It runs through the routed pipeline, so bucket download, `dataPreparation`, progress
reporting and cancellation all behave as they do for the ComfyUI families. Each uploaded
file emits a progress line, which doubles as the cancellation checkpoint on multi-image
batches.

Adding a resampling filter is a one-line change: append it to `RESAMPLING_METHODS`. The
registration string, the payload validator and the tests all read that tuple.
