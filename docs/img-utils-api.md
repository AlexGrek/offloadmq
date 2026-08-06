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
img-utils.<pack>[<operation>;<operation>;...]
```

| Part | Example | Meaning |
|------|---------|---------|
| `img-utils.` | — | Fixed prefix identifying the capability family |
| `<pack>` | `image_lotus_depth_v1_1` | The workflow directory on the agent, named after the **model/pack** |
| `[<operation>;...]` | `[depth]` | Operations the pack installs — one per `<operation>.json` file in that directory. The directory name is *not* itself an operation. |

**Agents register with extended attributes:**
```
img-utils.image_lotus_depth_v1_1[depth]
img-utils.face_swap_reactor[face_swap]
img-utils.seedvr2_upscale_image[upscale]
```

**Clients submit with base capability only (no brackets):**
```
img-utils.image_lotus_depth_v1_1
```

Because a pack usually installs exactly one operation, the client may omit `workflow`
and the agent runs the pack's sole operation; it errors out asking for `workflow`
only when a pack installs more than one.

### Enabling a utility on an agent

A utility is advertised **only if its workflow directory exists**, so installing the
workflow is what turns the capability on:

```
workflows/
  img-utils/
    image_lotus_depth_v1_1/       # pack directory = model name
      depth.json                  # ComfyUI API-format workflow graph (operation = file name)
      depth.params.json           # payload fields → node inputs
    face_swap_reactor/
      face_swap.json
      face_swap.params.json
    seedvr2_upscale_image/
      upscale.json
      upscale.params.json
```

Removing (or never adding) `workflows/img-utils/image_lotus_depth_v1_1/` means the agent
never registers `img-utils.image_lotus_depth_v1_1`. There is no separate config flag.
ComfyUI must also be reachable — the same `check_comfyui` probe gates `imggen`,
`txt2music` and `img-utils` alike.

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
| `workflow` | string | No | Operation to run (the `<operation>.json` in the pack directory). **Defaults to the pack's sole operation**, so a single-operation pack runs it when `workflow` is omitted. Must be one of the operations in the agent's extended attributes. |
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
| `img-utils.image_lotus_depth_v1_1` | `depth` | `input_image` | Lotus depth model (`lotus-depth-d-v1-1.safetensors`), 1 step, inverted output. |
| `img-utils.face_swap_reactor` | `face_swap` | `input_image` (target), `face_swap` (donor) | ReActor (`inswapper_128.onnx` + `GFPGANv1.3.onnx`). |
| `img-utils.seedvr2_upscale_image` | `upscale` | `input_image` | SeedVR2 upscaler. Takes a `scale_multiplier` knob (default 4). |

`face_swap` additionally accepts these `secondary_prompts` keys, mapped by its params
file: `face_restore_visibility`, `codeformer_weight`, `input_faces_index`,
`source_faces_index`, `detect_gender_input`, `detect_gender_source`.

`upscale` accepts a `secondary_prompts.scale_multiplier` number (mapped to the
`ResizeImageMaskNode`'s `resize_type.multiplier` input) — how many times larger the
output is on each edge.

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
    "capability":    "img-utils.image_lotus_depth_v1_1",
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
    "capability":    "img-utils.face_swap_reactor",
    "file_bucket":   [in_bucket],
    "output_bucket": out_bucket,
    "payload": {
        "input_image": "target.jpg",
        "face_swap":   "donor.jpg",
        "secondary_prompts": {"face_restore_visibility": 0.9},
    },
})
```

## Example — upscale

```python
requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":        KEY,
    "capability":    "img-utils.seedvr2_upscale_image",
    "file_bucket":   [in_bucket],
    "output_bucket": out_bucket,
    "payload": {
        "input_image": "source.jpg",
        "secondary_prompts": {"scale_multiplier": 4},
    },
})
```

---

## Adding a new utility

1. Export the workflow from ComfyUI in **API format**.
2. Save it as `workflows/img-utils/<pack>/<operation>.json` — the directory named after the
   model/pack, the file after the operation.
3. Generate `<operation>.params.json` — the agent web UI's Comfy page autowires it (pick the
   `img-utils` namespace so it emits image/scale fields only), or write it by hand mapping
   `input_image` (and `face_swap` / `scale_multiplier`) to the right node ids.
4. Restart / rescan the agent: it registers `img-utils.<pack>[<operation>]`.

No agent code change is needed. OAI picks the new tool up automatically —
`GET /api/img-utils/capabilities` lists whatever is online. Only a few things are
special-cased **by operation name**: operations starting with `face_swap` are asked for a
second image in the UI, operations starting with `upscale` get a scale-multiplier control,
and `OPERATION_HINTS` in `ImgUtilsPage.tsx` holds the one-line blurbs.

---

## OAI integration

The OAI web app exposes these tools at `/app/img-utils` ("Image Tools"), together with
**Basic resize** — the built-in [`image_resize`](image-resize-api.md) capability, which
shares this route group and job table but needs no ComfyUI. See the `oai-img` skill for
the frontend/backend layout; the route group is:

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
