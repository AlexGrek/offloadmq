# ImgGen API Contract

Payload contract between clients and agents for `imggen.*` tasks.
The server is transparent to task payloads — it routes tasks by capability string and passes the payload through unchanged.

---

## Capability Naming

```
imggen.<workflow-name>[<task-type>;<task-type>;...]
```

| Part | Example | Meaning |
|------|---------|---------|
| `imggen.` | — | Fixed prefix identifying the capability family |
| `<workflow-name>` | `wan-2.1-outpaint` | Exact name of the ComfyUI workflow loaded on the agent |
| `[<task-type>;...]` | `[txt2img;img2img;upscale]` | Extended attributes listing supported task types |

**Agents register with extended attributes:**
```
imggen.wan-2.1-outpaint[txt2img;img2img;outpaint;upscale]
imggen.flux-dev[txt2img;img2img]
imggen.svd[img2video]
```

**Clients submit with base capability only (no brackets):**
```
imggen.wan-2.1-outpaint
```

---

## Client → Agent Payload

Submitted as the `payload` field of `POST /api/task/submit` or `/api/task/submit_blocking`.

```json
{
  "workflow":           "txt2img",
  "prompt":             "a cat sitting on the moon, cinematic lighting",
  "secondary_prompts":  { "negative": "blurry, deformed, low quality" },
  "input_image":        "source.jpg",
  "face_swap":          "reference_face.jpg",
  "resolution":         { "width": 1024, "height": 1024 },
  "length":             48,
  "upscale":            2.0,
  "seed":               42
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workflow` | string | **Yes** | Task type to perform. Must be one of the task types declared in the agent's extended capability attributes (e.g. `txt2img`, `img2img`, `upscale`). |
| `prompt` | string | **Yes** | Primary text prompt describing the desired output. |
| `secondary_prompts` | object | No | Additional prompt fields. Keys are workflow-defined. Common key: `"negative"` for negative prompt. Agents silently ignore unrecognised keys. |
| `input_image` | string | No | Filename of an image in the linked file bucket. Required for `img2img`, `inpaint`, `outpaint`, `face_swap` workflows. |
| `face_swap` | string | No | Filename of a reference face image in the linked file bucket. Applied if the workflow supports face replacement. |
| `resolution` | object | No | `{"width": int, "height": int}`. If omitted, the agent uses the workflow's default resolution. |
| `length` | integer | No | Number of frames for video generation workflows (`txt2video`, `img2video`). |
| `upscale` | float | No | Upscale factor (e.g. `2.0` = 2×). Applied if the workflow supports upscaling. Ignored otherwise. |
| `seed` | integer | No | RNG seed for reproducibility. Omit or pass `-1` for a random seed. |

### File references

`input_image` and `face_swap` are **filenames within the file bucket** attached to the task — not URLs or paths on the client's filesystem. Upload the files to a storage bucket and attach it via `file_bucket` in the task submission:

```json
{
  "apiKey":     "your-client-api-key",
  "capability": "imggen.wan-2.1-outpaint",
  "payload": {
    "workflow":    "img2img",
    "prompt":      "cinematic portrait, dramatic lighting",
    "input_image": "portrait.jpg"
  },
  "file_bucket": ["bucket-uid-containing-portrait-jpg"]
}
```

The agent downloads all bucket files before execution. `input_image` and `face_swap` values are matched against downloaded filenames.

### Forward compatibility

Clients may include fields not listed here; agents must silently ignore unknown fields. This allows clients to be written against a newer contract than the agent implements.

---

## Agent → Client Output

Returned in the `output` field of task status polls.

### Image output (txt2img, img2img, upscale, inpaint, outpaint, face_swap)

```json
{
  "workflow":     "txt2img",
  "image_count":  1,
  "images": [
    {
      "filename":     "ComfyUI_00001_.png",
      "content_type": "image/png",
      "data_base64":  "<base64-encoded image bytes>"
    }
  ],
  "prompt_id": "6f3a21bc-...",
  "seed":      1234567890
}
```

### Video output (txt2video, img2video)

```json
{
  "workflow":    "txt2video",
  "frame_count": 48,
  "video": {
    "filename":     "ComfyUI_00001_.mp4",
    "content_type": "video/mp4",
    "data_base64":  "<base64-encoded video bytes>"
  },
  "prompt_id": "6f3a21bc-...",
  "seed":      1234567890
}
```

### Error output

```json
{
  "error":         "Workflow 'txt2video' is not supported by this agent",
  "response_text": "..."
}
```

---

## Standard Task Types

| `workflow` value | Description | Required input fields | Output key |
|------------------|-------------|----------------------|------------|
| `txt2img` | Text-to-image | `prompt` | `images` |
| `img2img` | Image-to-image | `prompt`, `input_image` | `images` |
| `inpaint` | Fill masked region | `prompt`, `input_image` | `images` |
| `outpaint` | Extend image beyond borders | `prompt`, `input_image`, `resolution` | `images` |
| `upscale` | Increase resolution | `input_image`, `upscale` | `images` |
| `face_swap` | Replace face | `input_image`, `face_swap` | `images` |
| `txt2video` | Text-to-video | `prompt`, `length` | `video` |
| `img2video` | Image-to-video | `input_image`, `length` | `video` |

Not all agents support all task types. The agent's extended capability attributes declare what it supports. If a client submits a `workflow` value not listed in the agent's extended attributes, the agent reports a failure.

---

## Agent Configuration

| Config key (`config.json`) | Default | Description |
|----------------------------|---------|-------------|
| `comfyui_url` | `http://127.0.0.1:8188` | Base URL of the ComfyUI HTTP API |

Example `.offload-agent.json`:
```json
{
  "comfyui_url": "http://192.168.1.50:8188"
}
```

---

## Agent Implementation Notes

### Resolving the ComfyUI workflow name

The ComfyUI workflow name is the part of the capability string after `imggen.`:

```
imggen.wan-2.1-outpaint  →  ComfyUI workflow: "wan-2.1-outpaint"
imggen.flux-dev           →  ComfyUI workflow: "flux-dev"
```

### Workflow templates

Agents maintain a local directory of ComfyUI API-format workflow templates and a sidecar parameter-mapping file for each task type:

```
workflows/
  wan-2.1-outpaint/
    txt2img.json          # ComfyUI API-format workflow graph
    txt2img.params.json   # maps payload fields → node inputs
    img2img.json
    img2img.params.json
  flux-dev/
    txt2img.json
    txt2img.params.json
```

### Parameter mapping (`.params.json`)

Each `.params.json` file maps normalised payload field names to one or more `[node_id, input_name]` pairs in the workflow graph:

```json
{
  "prompt":      [["6",  "text"]],
  "negative":    [["7",  "text"]],
  "width":       [["5",  "width"]],
  "height":      [["5",  "height"]],
  "seed":        [["3",  "seed"]],
  "input_image": [["10", "image"]],
  "upscale":     [["14", "upscale_factor"]]
}
```

`negative` is sourced from `secondary_prompts.negative`. `input_image` and `face_swap` values are resolved to the ComfyUI-uploaded image name before injection (agents upload files via ComfyUI's `/upload/image` endpoint).

Fields absent from the payload are left at the workflow template's default values. Unknown payload fields are ignored.

---

## Examples

### txt2img (non-blocking)

```python
import requests, time

BASE  = "http://localhost:3069"
KEY   = "client_secret_key_123"

# 1. Submit
resp = requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":     KEY,
    "capability": "imggen.wan-2.1-outpaint",
    "payload": {
        "workflow": "txt2img",
        "prompt":   "a wolf howling at the moon, oil painting",
        "secondary_prompts": {"negative": "blurry, cartoon"},
        "resolution": {"width": 1024, "height": 1024},
        "seed": 42,
    },
})
task_id = resp.json()["id"]

# 2. Poll until done
while True:
    r = requests.post(
        f"{BASE}/api/task/poll/{task_id['cap']}/{task_id['id']}",
        json={"apiKey": KEY},
    )
    data = r.json()
    if data["status"] == "completed":
        images = data["output"]["images"]
        print(f"Got {len(images)} image(s), first: {images[0]['filename']}")
        break
    if data["status"] == "failed":
        print("Failed:", data["output"])
        break
    time.sleep(2)
```

### img2img with bucket file

```python
import requests

BASE = "http://localhost:3069"
KEY  = "client_secret_key_123"

# 1. Create a bucket and upload input image
bucket = requests.post(f"{BASE}/api/storage/bucket/create",
    json={"apiKey": KEY}).json()
bucket_uid = bucket["uid"]

with open("source.jpg", "rb") as f:
    requests.post(
        f"{BASE}/api/storage/bucket/{bucket_uid}/upload",
        headers={"X-API-Key": KEY},
        files={"file": ("source.jpg", f, "image/jpeg")},
    )

# 2. Submit task referencing the bucket
resp = requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":      KEY,
    "capability":  "imggen.wan-2.1-outpaint",
    "file_bucket": [bucket_uid],
    "payload": {
        "workflow":    "img2img",
        "prompt":      "turn this into an oil painting",
        "input_image": "source.jpg",
        "resolution":  {"width": 768, "height": 768},
    },
})
print(resp.json())
```

### upscale

```python
requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":      KEY,
    "capability":  "imggen.wan-2.1-outpaint",
    "file_bucket": [bucket_uid],
    "payload": {
        "workflow":    "upscale",
        "prompt":      "",
        "input_image": "low_res.jpg",
        "upscale":     4.0,
    },
})
```

### img2video

```python
requests.post(f"{BASE}/api/task/submit", json={
    "apiKey":      KEY,
    "capability":  "imggen.svd",
    "file_bucket": [bucket_uid],
    "payload": {
        "workflow":    "img2video",
        "prompt":      "gentle camera pan, smooth motion",
        "input_image": "scene.jpg",
        "length":      25,
    },
})
```
