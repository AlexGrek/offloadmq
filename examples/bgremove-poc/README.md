# Background-removal PoC

This compares ONNX background-removal models on real generated characters before
wiring them into the agent (`onnx.bgremove.*`, see [docs/bgremove-api.md](../../docs/bgremove-api.md)).

```bash
cd agent_v2
# models: drop the .onnx files into one dir (URLs/md5s in onnx_models.ONNX_MODEL_REGISTRY;
# isnet-anime / rmbg-1.4 from rembg's v0.0.0 release and briaai/RMBG-1.4 for comparison)
uv run python ../examples/bgremove-poc/poc.py --models-dir E:/offload-agent/onnx-models \
    --out E:/bgremove-poc/runs/1 C:/AI/output/a.png C:/AI/output/b.png
# compact side-by-side (original + each model over a flat colour), optional zoom box
uv run python ../examples/bgremove-poc/compare.py E:/bgremove-poc/runs/1 cmp.jpg a b --cell 250
uv run python ../examples/bgremove-poc/compare.py E:/bgremove-poc/runs/1 zoom.jpg a \
    --models birefnet-general,birefnet-portrait --bg 20,30,90 --crop 0.3,0.08,0.75,0.32
```

`poc.py` writes one `<stem>.grid.jpg` per image: mask, checkerboard, flat colour with
raw colours, and flat colour with foreground estimation. It also writes an RGBA PNG per
model and `timings.json`.

## Result (2026-11-22, 10 images, onnxruntime 1.26 CPU)

| Model | CPU s/img | Anime (busy scene) | Realistic | Verdict |
|---|---|---|---|---|
| BiRefNet-general | 10.2 | best, the only one that keeps banners, poles and the staff | clean, keeps the bowstring | **default** |
| BiRefNet-portrait | 10.9 | drops held props (staff, shield) | clean, softer hair | people only |
| BiRefNet-lite | 6.2 | misses banners | keeps background objects (hand dryer) | small download |
| RMBG-1.4 | 0.6 | misses banners, some fragments | stray objects (bag, hand dryer) | rejected; non-commercial licence |
| IS-Net anime | 0.6 | kept half the town on one image | semi-transparent people | rejected |

IS-Net anime was retried with rembg's normalisation and with stretch instead of
letterbox. Every variant failed the same way.
