# img-utils API Contract

Payload contract between clients and agents for `img-utils.*` tasks — single-purpose
ComfyUI image transforms (depth map, face swap, …). The server is transparent to task
payloads; it routes by capability string and passes the payload through unchanged.

`img-utils` is a sibling of [`imggen`](comfy-api.md): same transport, same output shape,
same ComfyUI plumbing on the agent. The difference is intent — an `imggen.*` capability
names a *generation model* that supports several task types, whereas an `img-utils.*`
capability names *one tool* that either exists on the agent or does not.

---

## Capability Naming

```
img-utils.<utility>[<task-type>;<task-type>;...]
```

| Part | Example | Meaning |
|------|---------|---------|
| `img-utils.` | — | Fixed prefix identifying the capability family |
| `<utility>` | `depth` | The tool. Also the name of the workflow directory on the agent |
| `[<task-type>;...]` | `[depth]` | Task types available for this utility (the JSON files in that directory) |

**Agents register with extended attributes:**
```
img-utils.depth[depth]
img-utils.face_swap[face_swap]
```

**Clients submit with base capability only (no brackets):**
```
img-utils.depth
```

### Enabling a utility on an agent

A utility is advertised **only if its workflow directory exists**, so installing the
workflow is what turns the capability on:

```
workflows/
  img-utils/
    depth/
      depth.json           # ComfyUI API-format workflow graph
      depth.params.json    # payload fields → node inputs
    face_swap/
      face_swap.json
      face_swap.params.json
```

Removing (or never adding) `workflows/img-utils/depth/` means the agent never registers
`img-utils.depth`. There is no separate config flag. ComfyUI must also be reachable —
the same `check_comfyui` probe gates `imggen`, `txt2music` and `img-utils` alike.

The agent resolves its workflows directory in this order: `$OFFLOAD_WORKFLOWS_DIR`,
`~/.offload-agent/workflows` (the persistent location for packaged agents),
`$CWD/workflows`, then a development fallback. Reference copies of the bundled workflows
live in [offload-agent/workflows/](../offload-agent/workflows/) — copy the ones you want
into the agent's directory; they are not installed automatically.

---

## Client → Agent Payload

Submitted as the `payload` field of `POST /api/task/submit`.

```json
{
  "workflow":     "depth",
  "input_image":  "source.jpg",
  "face_swap":    "reference_face.jpg",
  "resolution":   { "width": 1024, "height": 768 },
  "secondary_prompts": { "face_restore_visibility": 0.9 }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workflow` | string | No | Task type. **Defaults to the utility name**, so `img-utils.depth` runs `depth.json` when omitted. Must be one of the task types in the agent's extended attributes. |
| `input_image` | string | **Yes** | Filename of the main image in the linked file bucket. |
| `face_swap` | string | Only for face-swap | Filename of the face-reference image in the bucket. |
| `resolution` | object | No | `{"width": int, "height": int}`. Not injected by the bundled workflows — the output tracks the input size — but the server uses it to scale its runtime estimate. |
| `secondary_prompts` | object | No | Extra per-workflow knobs, written into whatever nodes `<task-type>.params.json` maps them to. Unrecognised keys are silently ignored. |
| `seed` | integer | No | Injected only if the workflow's param map has a `seed` entry. Most utilities are deterministic and ignore it. |

File references work exactly as in [comfy-api.md](comfy-api.md#file-references): upload to a
bucket, pass the bucket UID in `file_bucket`, and reference files by name.
`output_bucket` is **required** — img-utils never falls back to base64.

### Bundled utilities

| Capability | `workflow` | Inputs | Notes |
|-----------|-----------|--------|-------|
| `img-utils.depth` | `depth` | `input_image` | Lotus depth model (`lotus-depth-d-v1-1.safetensors`), 1 step, inverted output. |
| `img-utils.face_swap` | `face_swap` | `input_image` (target), `face_swap` (donor) | ReActor (`inswapper_128.onnx` + `GFPGANv1.3.onnx`). |

`img-utils.face_swap` additionally accepts these `secondary_prompts` keys, mapped by its
params file: `face_restore_visibility`, `codeformer_weight`, `input_faces_index`,
`source_faces_index`, `detect_gender_input`, `detect_gender_source`.

---

## Agent → Client Output

Identical to the imggen image output — one `images` array of bucket references:

```json
{
  "workflow":      "depth",
  "image_count":   1,
  "output_bucket": "550e8400-e29b-41d4-a716-446655440000",
  "images": [
    {
      "filename":     "Lotus_depth_00001_.png",
      "content_type": "image/png",
      "file_uid":     "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
      "bucket_uid":   "550e8400-e29b-41d4-a716-446655440000"
    }
  ],
  "prompt_id": "6f3a21bc-..."
}
```

Download results via `GET /api/storage/bucket/{bucket_uid}/file/{file_uid}`.

---

## Example — depth map

```python
import requests, time

BASE = "http://localhost:3069"
KEY  = "client_secret_key_123"
hdrs = {"X-API-Key": KEY}

in_bucket  = requests.post(f"{BASE}/api/storage/bucket/create", headers=hdrs).json()["bucket_uid"]
out_bucket = requests.post(f"{BASE}/api/storage/bucket/create", headers=hdrs).json()["bucket_uid"]

with open("source.jpg", "rb") as f:
    requests.post(
        f"{BASE}/api/storage/bucket/{in_bucket}/upload",
        headers=hdrs,
        files={"file": ("source.jpg", f, "image/jpeg")},
    )

resp = requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":        KEY,
    "capability":    "img-utils.depth",
    "file_bucket":   [in_bucket],
    "output_bucket": out_bucket,
    "payload": {"input_image": "source.jpg"},
})
task = resp.json()["id"]
```

## Example — face swap

```python
requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":        KEY,
    "capability":    "img-utils.face_swap",
    "file_bucket":   [in_bucket],
    "output_bucket": out_bucket,
    "payload": {
        "input_image": "target.jpg",
        "face_swap":   "donor.jpg",
        "secondary_prompts": {"face_restore_visibility": 0.9},
    },
})
```

---

## Adding a new utility

1. Export the workflow from ComfyUI in **API format**.
2. Save it as `workflows/img-utils/<utility>/<utility>.json`.
3. Generate `<utility>.params.json` — the agent web UI's Comfy page autowires it, or write
   it by hand mapping `input_image` (and `face_swap`) to the `LoadImage` node ids.
4. Restart / rescan the agent: it registers `img-utils.<utility>[<utility>]`.

No agent code change is needed. OAI picks the new tool up automatically —
`GET /api/img-utils/capabilities` lists whatever is online. Only two things are
special-cased by name: utilities starting with `face_swap` are asked for a second image
in the UI, and `UTILITY_HINTS` in `ImgUtilsPage.tsx` holds the one-line blurbs.

---

## OAI integration

The OAI web app exposes these tools at `/app/img-utils` ("Image Tools"). See the
`oai-img` skill for the frontend/backend layout; the route group is:

```text
GET    /api/img-utils/capabilities
POST   /api/img-utils/jobs
GET    /api/img-utils/jobs
GET    /api/img-utils/jobs/{id}
POST   /api/img-utils/jobs/{id}/poll
POST   /api/img-utils/jobs/{id}/cancel
POST   /api/img-utils/jobs/{id}/retry
DELETE /api/img-utils/jobs/{id}
```

Input images are uploaded through the shared `POST /api/images/upload`; results are stored
as regular `image_files` rows, so they are served by `GET /api/images/files/{id}` and appear
under **My Files** like any generated image.
