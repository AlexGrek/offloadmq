# onnx.bgremove.* API Contract

Payload contract between clients and agents for **background removal**: one image in,
the subject cut out as a transparent PNG/WebP, or composited onto a solid colour as
PNG/WebP/JPEG. The primary use case is game-character sprites from generated persona
images, both anime and realistic.

The models are ONNX segmentation networks run with `onnxruntime` on the agent: no
ComfyUI and no GPU needed (CUDA or DirectML is used if the agent's onnxruntime build has
it). They are managed by the same registry as `onnx.nudenet`.

---

## Models / capabilities

One capability per **installed** model. A model is advertised only once its file is on
disk.

| Capability | Registry name (for `onnx-models-prepare`) | Size | CPU time, 832×1216 | Use for |
|---|---|---|---|---|
| `onnx.bgremove.birefnet-general` | `bgremove-birefnet-general` | 973 MB | ~10 s | **Default.** Both anime and realistic characters, and keeps held props (staff, banner, bow and bowstring). |
| `onnx.bgremove.birefnet-portrait` | `bgremove-birefnet-portrait` | 973 MB | ~11 s | People only. Hair edges are slightly softer, and it tends to drop held props. |
| `onnx.bgremove.birefnet-lite` | `bgremove-birefnet-lite` | 224 MB | ~6 s | Small download and less RAM. It misses thin props and sometimes keeps background objects. |

All three are BiRefNet ([ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet), MIT),
using the ONNX exports that [rembg](https://github.com/danielgatis/rembg) re-hosts.
Downloads are verified against rembg's pinned MD5s. The timings are for
`onnxruntime` on CPU, plus about 8 s to load the model on the first task (sessions are
cached after that). An onnxruntime build with CUDA or DirectML is used automatically
when present.

### Why these models (PoC, 2026-11)

Five models were compared on 10 generated characters: 5 anime (NetaYume) and 5
realistic (Krea2 and face-swapped personas). Most were full-body shots with weapons
and capes in busy town, market or forest scenes. Script and sheets:
[`examples/bgremove-poc/`](../examples/bgremove-poc/).

- **BiRefNet-general** was the only model that kept thin props (banner poles, a staff,
  a bowstring) while removing all of the background, on both anime and photos.
- **IS-Net anime** (skytnt anime-segmentation, the usual "anime" pick) failed on busy
  painted backgrounds: on one image it kept half the town. It also turned the realistic
  images semi-transparent. All preprocessing variants behaved the same, so the cause
  is the model, not the integration. Rejected.
- **RMBG-1.4** (BRIA) was fast (0.6 s on CPU) but kept stray objects, such as a hanging
  bag and a hand dryer, and dropped banners. Its licence is also non-commercial.
  Rejected.

---

## Choosing a model as a client

Default to `onnx.bgremove.birefnet-general`. If a result looks wrong, check
`foreground_ratio`. Near 0 means nothing was detected, and near 1 means the background
was kept. Retry with `-portrait` for single-person images.

## Installing and configuring (agent side)

Nothing is downloaded with the agent. Models go into `onnx_models_dir`
(default `~/.offload-agent/onnx-models/`, shared with `onnx.nudenet`), and each one is
md5-verified against rembg's pinned checksum.

**On the agent machine: CLI** (`agent_v2/`, or the `omq` binary):

```bash
omq bgremove status                          # models, device, providers (fast)
omq bgremove install                         # birefnet-general (default)
omq bgremove install birefnet-lite birefnet-portrait
omq bgremove install --all | --force         # every model / delete and re-download
omq bgremove config --device cuda --threads 8 --no-keep-loaded --models-dir E:/onnx
omq bgremove doctor [--fix]                  # onnxruntime, device, dir, md5 of every model
omq bgremove uninstall [model…] [--yes]      # default: all bg-removal models; nudenet stays
```

Taskfile shortcuts: `task bgremove:install MODELS="birefnet-lite"`,
`task bgremove:doctor FIX=1`, `task bgremove:uninstall`.

**On the agent machine: web UI.** The **Background removal** page has the same controls:
per-model install, reinstall and remove, Doctor, Repair (re-downloads corrupt models or
installs the default), Cancel, and a settings form. Its REST API is under
`/api/bgremove/*`: `status`, `settings`, `install`, `doctor`, `repair`, `uninstall`,
`cancel`.

**Remotely: slavemode.**

- Management UI: **Agents → ONNX**, name `bgremove-birefnet-general` → Prepare
- `omqcli agent <id> onnx prepare bgremove-birefnet-general`
- the `slavemode.onnx-models-prepare` task with payload `{"name": "bgremove-birefnet-general"}`

Installs, removals and settings changes all trigger a capability rescan.

### Agent settings (`~/.offloadmq-agent.json`)

| Setting | Default | Meaning |
|---|---|---|
| `onnx_models_dir` | `""` → `~/.offload-agent/onnx-models` | Where the model files live. Changing it does not move files. |
| `bgremove_device` | `auto` | `auto` uses CUDA, then DirectML, then CPU, whichever the onnxruntime build has. `cuda`, `directml` and `cpu` force one. If the forced device is missing from the build, `onnx.bgremove.*` is **not advertised** and doctor says why. |
| `bgremove_threads` | `0` | CPU intra-op threads per inference. `0` means the onnxruntime default (all cores). Lower it to keep the machine responsive. |
| `bgremove_keep_loaded` | `true` | Keep sessions in RAM between tasks (about 4 GB per BiRefNet, and it saves the ~8 s load). Turn it off on low-RAM agents. |

Device and thread changes apply to the next task, because cached sessions are dropped
on save.

---

## Client → Agent Payload

Submitted as the `payload` field of `POST /api/task/submit`, with capability e.g.
`onnx.bgremove.birefnet-general`.

```json
{
  "input_image": "hero.png",
  "format": "png",
  "background": "transparent",
  "crop": true,
  "padding": 16
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `input_image` | string \| string[] | every image in the bucket | Filename(s) in the linked file bucket. `input_images` is accepted as an alias. |
| `format` | string | `png` | `png`, `webp`, or `jpeg`/`jpg`. |
| `background` | string \| int[3] | `transparent` | `"transparent"`, `"#RRGGBB"`, or `[r, g, b]`. JPEG cannot be transparent, so JPEG defaults to white. |
| `crop` | bool | `false` | Trim the output to the subject's bounding box (pixels with alpha > 5%). |
| `padding` | int 0–4096 | `0` | Margin around the crop, clamped to the frame. |
| `refine_foreground` | bool | `true` | Fixes the colours of semi-transparent edge pixels so the old background does not show as a halo around hair. Only turn it off to get the raw input colours. |
| `alpha_threshold` | float (0,1) | none (soft) | Turn the soft matte into hard 0/1 alpha at this cut-off, e.g. for engines or pixel-art pipelines that cannot blend. |
| `return_mask` | bool | `false` | Also upload the alpha matte as `<stem>.mask.png` (8-bit grayscale). |
| `quality` | int 1–100 | 95 | JPEG/WebP quality. |

`output_bucket` is **required**: results are always bucket files, never base64. File
references work as described in [comfy-api.md](comfy-api.md#file-references). EXIF
orientation is applied before inference.

---

## Agent → Client Output

```json
{
  "model": "bgremove-birefnet-general",
  "format": "png",
  "background": "transparent",
  "image_count": 1,
  "output_bucket": "550e8400-…",
  "images": [
    {
      "filename": "hero.png",
      "content_type": "image/png",
      "width": 512, "height": 1100,
      "original_width": 832, "original_height": 1216,
      "transparent": true,
      "subject_bbox": {"x": 160, "y": 58, "width": 512, "height": 1100},
      "foreground_ratio": 0.3123,
      "file_uid": "…",
      "bucket_uid": "550e8400-…",
      "mask_filename": "hero.mask.png",
      "mask_file_uid": "…"
    }
  ]
}
```

- `subject_bbox`: the crop rectangle in source pixels (padding included) when `crop` is
  set, otherwise the subject's bounds. It is `null` when nothing was detected.
- `foreground_ratio`: mean alpha of the output. A value near 0 means the model found no
  subject, and you probably want a different model.
- Output filenames keep the input's stem and take the output format's extension.
  Download them with `GET /api/storage/bucket/{bucket_uid}/file/{file_uid}`.

On failure the task resolves with `{"error": "<message>"}`.

---

## Example: transparent sprite, cropped

```python
import requests

BASE, KEY = "http://localhost:3069", "client_secret_key_123"
hdrs = {"X-API-Key": KEY}
mk = lambda: requests.post(f"{BASE}/api/storage/bucket/create", headers=hdrs).json()["bucket_uid"]
in_bucket, out_bucket = mk(), mk()

with open("hero.png", "rb") as f:
    requests.post(f"{BASE}/api/storage/bucket/{in_bucket}/upload", headers=hdrs,
                  files={"file": ("hero.png", f, "image/png")})

task = requests.post(f"{BASE}/api/task/submit", json={
    "apiKey": KEY,
    "capability": "onnx.bgremove.birefnet-general",
    "file_bucket": [in_bucket],
    "output_bucket": out_bucket,
    "payload": {"crop": True, "padding": 16},
}).json()["id"]
```

## Example: realistic persona on a flat studio colour, as JPEG

```python
requests.post(f"{BASE}/api/task/submit", json={
    "apiKey": KEY,
    "capability": "onnx.bgremove.birefnet-general",
    "file_bucket": [in_bucket],
    "output_bucket": out_bucket,
    "payload": {"format": "jpeg", "background": "#2b2b35", "quality": 92},
})
```

---

## Implementation

- Executor: [`exec/bgremove.py`](../agent_v2/agent/src/offloadmq_agent/exec/bgremove.py).
  `MODEL_SPECS` holds each model's preprocessing: square input size, normalisation,
  and whether the output is logits that need a sigmoid.
- Registry and downloads: [`onnx_models.py`](../agent_v2/agent/src/offloadmq_agent/onnx_models.py).
- Settings, device resolution and status:
  [`exec/bgremove_runtime.py`](../agent_v2/agent/src/offloadmq_agent/exec/bgremove_runtime.py).
  It is cheap enough to run on every capability scan.
- Install, doctor, repair and uninstall:
  [`core/bgremove_install.py`](../agent_v2/core/src/offloadmq_core/bgremove_install.py).
  These are driven by `omq bgremove`, the orchestrator's `*_bgremove_*` methods,
  `ui_server/routes/bgremove.py` and `BgRemovePage.tsx`.
- Inference sessions are cached per process, because BiRefNet takes a few seconds to load.
- Edge colours are fixed with blur-fusion foreground estimation (Forte & Pitié,
  *Approximate Fast Foreground Colour Estimation*, ICIP 2021), implemented in plain
  numpy.
- PoC and model comparison: [`examples/bgremove-poc/`](../examples/bgremove-poc/).

### Adding a model

1. Add a registry entry (`urls`, `filename`, `md5`, `size_bytes`,
   `capability: onnx.bgremove.<x>`) to `ONNX_MODEL_REGISTRY` under the name
   `bgremove-<x>`. The CLI, the GUI and doctor pick it up automatically.
2. Add its `ModelSpec` to `MODEL_SPECS` in `exec/bgremove.py`.
3. Check it on real images with `examples/bgremove-poc/poc.py` first.
