# Workflow Templates

Each subdirectory is a ComfyUI workflow name, matching the part after `imggen.` in the agent capability string.

```
workflows/
  <workflow-name>/
    <task-type>.json          # ComfyUI API-format workflow graph
    <task-type>.params.json   # parameter mapping (payload fields → node inputs)
```

## Example

For capability `imggen.wan-2.1-outpaint[txt2img;img2img]`:

```
workflows/
  wan-2.1-outpaint/
    txt2img.json
    txt2img.params.json
    img2img.json
    img2img.params.json
```

## How to export a workflow from ComfyUI

1. Open the workflow in ComfyUI
2. Click the **gear icon** → enable **Dev Mode**
3. Click **Save (API Format)** — this saves the JSON in the format the executor expects
4. Save it here as `<workflow-name>/<task-type>.json`

## params.json format

Maps normalised payload field names to lists of `[node_id, input_name]` targets in the workflow graph.
Find node IDs in the exported workflow JSON (they are the top-level numeric keys).

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

Supported payload field names: `prompt`, `negative`, `width`, `height`, `seed`,
`length`, `upscale`, `input_image`, `face_swap`, plus any keys from `secondary_prompts`
(e.g. `"style"`, `"lora_strength"`).

Fields absent from the payload are left at the template's default value.
Unknown payload fields are silently ignored.
