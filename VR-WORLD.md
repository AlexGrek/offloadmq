# From generated art to a Meta Quest 3 world

## What to build first

Generate one explorable artwork on the RTX 5070 Ti 16 GB, copy one file to the Quest 3, and view it untethered. Start with a painting of a courtyard seen through an arch. At the starting viewpoint the composition should match the painting. When the viewer turns around, the courtyard should continue behind them. When they lean sideways, the near edge of the arch should move across the distant fountain. Those three observations test art fidelity, world generation, and depth independently.

The intended experience is a gallery of places. Each place has an authored starting viewpoint, a level horizon, and a small area where head movement looks convincing. A controller-selected doorway can lead to another place. One viewpoint on a working headset is the first milestone. Two linked viewpoints are the second. Game physics, characters, and a level editor add no value to these experiments.

### Choose the representation by the movement it supports

| Experience | How it works | Best use |
|---|---|---|
| **Gaussian splat on Quest** | A collection of oriented, colored, translucent 3D elements renders separately for each eye. Head rotation and translation both change the view. Single-image generation must infer obscured surfaces. | Default for foreground subjects, rooms, and short physical leans. Keep an original 3DGS PLY for interchange. |
| **360° panorama on Quest** | A mono equirectangular image wraps around a fixed viewpoint. Both eyes see the same scenery. The viewer can look in all directions and select hotspots. | Distant landscapes or scenes whose generated geometry breaks when leaning. Use a WebXR panorama viewer such as [krpano](https://krpano.com/plugins/webvr/). |
| **Splat rendered on the PC** | The 5070 Ti renders stereo views. The Quest receives them through Link or Air Link. | Diagnose headset rendering limits or view larger scenes at home. A faster renderer still shows any holes present in the file. [OpenXR splat viewer](https://github.com/Enndee/Splatviewer_VR) |

## Tooling and where it runs

| Where | Needed for the first run | Purpose |
|---|---|---|
| Art workstation | One existing RGB PNG or JPEG. ComfyUI is optional when the image already exists. | Supply a clean perspective image. Keep its prompt and workflow with the source if available. |
| Generation machine | RTX 5070 Ti 16 GB, x86-64 Linux environment, NVIDIA driver, CUDA 12.8-compatible toolkit and C++ build tools, Git, Conda, Python 3.11, internet access and space for model caches | Run WorldGen and compile PyTorch3D. CPU offloading also consumes host RAM. Check available RAM and disk before downloading models. Native Linux is the reference setup here. WSL2 with GPU access is a candidate for a Windows host and needs the same CUDA smoke test. |
| Generation environment | CUDA PyTorch and torchvision, xFormers, Nunchaku, WorldGen, DA-2, PyTorch3D, Hugging Face account with access to FLUX.1 Fill [dev] | Extend the painting into a panorama, estimate depth, and convert color and depth to a Gaussian splat. WorldGen reports about 10 GB VRAM for low-memory generation. Peak consumption on this GPU and software combination is an experiment result. [WorldGen](https://github.com/ZiYang-xie/WorldGen) · [Image model loader](https://github.com/ZiYang-xie/WorldGen/blob/7ce7b2767fdf31e2727b69a2e61e2e950e3a017f/src/worldgen/pano_gen.py) |
| Quest 3 | Headset browser, Touch controllers, HTTPS viewer, and a way to put the PLY in Downloads, such as USB file transfer | Render on the headset. The StrikeLines viewer takes a local file. SuperSplat also supports hosted WebXR scenes. [Local-file viewer](https://strikelines.github.io/quest-splats-and-3d-models/) · [SuperSplat XR](https://developer.playcanvas.com/user-manual/supersplat/viewer/xr/) |
| Measurement | `nvidia-smi`, a timer, and a headset frame-rate readout when available | Record generation memory, load time, and actual application frame rate. Meta's OVR Metrics Tool is an option for instrumented Quest tests. [OVR Metrics Tool](https://developers.meta.com/horizon/documentation/native/android/ts-ovrmetricstool/) |

The generation machine can be separate from the machine running OffloadMQ or serving the viewer. Standalone playback uses the Quest GPU after file transfer. The Windows Link software and a suitable USB cable or wireless network are needed only for the PC-rendered comparison. [Meta Link setup](https://www.meta.com/help/quest/509273027107091/)

## First run

### 1. Check the headset before installing models

Open a published scene from [SuperSplat](https://superspl.at/) in the Quest browser. Enter VR using the viewer toolbar and accept the switch to WebGL if offered. Turn your head, lean, and return to the starting pose. Then open the [StrikeLines file picker](https://strikelines.github.io/quest-splats-and-3d-models/) and confirm it can browse Downloads. This gives you a working XR control scene if your own file later fails.

### 2. Prepare the 5070 Ti worker

Run the following in a Linux shell on the **GPU machine**. Use a fresh environment outside this repository. The inspected WorldGen revision explicitly depends on a CPython 3.11 Linux x86-64 Nunchaku wheel built for Torch 2.7. The versions below are a candidate stack aligned to that wheel and the CUDA 12.8 PyTorch index. Verify the combination on the target machine before freezing it for an agent. [WorldGen package metadata](https://github.com/ZiYang-xie/WorldGen/blob/7ce7b2767fdf31e2727b69a2e61e2e950e3a017f/pyproject.toml) · [PyTorch release wheels](https://pytorch.org/get-started/previous-versions/) · [PyTorch3D build requirements](https://github.com/facebookresearch/pytorch3d/blob/main/INSTALL.md)

```bash
nvidia-smi
nvcc --version
c++ --version
df -h .
free -h
git clone --recursive https://github.com/ZiYang-xie/WorldGen.git
cd WorldGen
git checkout 7ce7b2767fdf31e2727b69a2e61e2e950e3a017f
git submodule update --init --recursive
conda create -y -n vr-world python=3.11
conda activate vr-world
python -m pip install torch==2.7.0 torchvision==0.22.0 xformers==0.0.30 --index-url https://download.pytorch.org/whl/cu128
python -m pip install setuptools wheel ninja packaging plyfile omegaconf
python -m pip freeze | grep -E '^(torch|torchvision|xformers)==' > gpu-constraints.txt
python -m pip install -c gpu-constraints.txt .
python -m pip install --no-deps 'git+https://github.com/EnVision-Research/DA-2.git#subdirectory=src'
python -m pip install --no-build-isolation 'git+https://github.com/facebookresearch/pytorch3d.git'
```

The constraints file keeps the chosen Torch stack while pip resolves WorldGen. Upstream installs DA-2 with `--no-deps` because its training package pins an older Torch stack. The WorldGen revision is fixed here. The two Git dependencies above follow upstream, so record their resolved commits with the successful environment. [WorldGen installation](https://github.com/ZiYang-xie/WorldGen#-installation)

```bash
python - <<'PY'
import torch
from nunchaku import NunchakuFluxTransformer2dModel
from pytorch3d.transforms import matrix_to_quaternion
from worldgen import WorldGen

print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0))
matrix = torch.eye(3, device="cuda").unsqueeze(0)
print("Quaternion from CUDA identity matrix:", matrix_to_quaternion(matrix).cpu())
PY
```

Expect the 5070 Ti name and an identity quaternion. This exercises a CUDA operation and imports the native model dependency. The first real inference still needs to exercise Nunchaku's quantized kernels. Obtain access to FLUX.1 Fill [dev] on the same Hugging Face account used by the worker and authenticate interactively with `hf auth login` (older clients use `huggingface-cli login`). Text-to-scene uses a different FLUX checkpoint. The image path also downloads a WorldGen LoRA, quantized Fill transformer, and DA-2 depth weights on first use. [FLUX Fill model and access](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev) · [Depth checkpoint](https://huggingface.co/haodongli/DA-2)

### 3. Generate a transferable splat

Save your art as `input/courtyard.png` under the WorldGen checkout. Pick a level horizon, one solid foreground edge, and something recognizable at middle distance. Close ComfyUI or unload its models so the 16 GB card runs one generation stage at a time. Create a fresh output directory for each experiment. The demo always writes the same output filename.

```bash
mkdir -p runs/courtyard-01
git rev-parse HEAD > runs/courtyard-01/worldgen-revision.txt
python -m pip freeze > runs/courtyard-01/environment.txt
sha256sum input/courtyard.png > runs/courtyard-01/input.sha256
python demo.py --image input/courtyard.png \
  --prompt "A quiet stone courtyard seen through an arch, with a fountain at its center" \
  --low_vram --save_scene --output_dir runs/courtyard-01
```

Expect **`runs/courtyard-01/splat.ply`** and a Viser desktop preview at the local URL printed by the demo, normally port 8080. The `--save_scene` flag triggers the file write. Stop the demo with Ctrl-C after inspection. Separate first-run downloads from warm generation time. In another terminal, sample GPU usage while the job runs, then stop sampling with Ctrl-C. [WorldGen demo implementation](https://github.com/ZiYang-xie/WorldGen/blob/7ce7b2767fdf31e2727b69a2e61e2e950e3a017f/demo.py)

```bash
nvidia-smi --query-gpu=timestamp,memory.used,memory.total,utilization.gpu --format=csv -l 1 > runs/courtyard-01/gpu.csv
```

In the same Python environment, check the output before transfer. A mesh or plain point cloud can also use the PLY extension. Gaussian-specific attributes identify the expected payload.

```bash
python - <<'PY'
from pathlib import Path
from plyfile import PlyData

path = Path("runs/courtyard-01/splat.ply")
vertices = PlyData.read(path)["vertex"]
required = {"x", "y", "z", "opacity", "f_dc_0", "scale_0", "rot_0"}
assert vertices.count > 0 and required.issubset(vertices.data.dtype.names)
print(f"{vertices.count:,} splats, {path.stat().st_size / 1048576:.1f} MiB")
PY
```

### 4. View your art in the Quest

1. Copy `splat.ply` to the headset's Downloads folder as `courtyard-01.ply`. If the GPU worker is remote, download the file to the computer used for transfer first.
2. Open the HTTPS viewer in the **headset browser**. Choose the file from Downloads and tap **Enter VR**. For self-hosting, serve the viewer from an HTTPS origin trusted by the headset. The worker's desktop localhost address refers to a different machine from inside the Quest. [Launch viewer](https://strikelines.github.io/quest-splats-and-3d-models/) · [WebXR secure contexts](https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Startup_and_shutdown)
3. Set the scene upright and level. Use one grip to move the scene and both grips to scale it. Place the viewpoint inside the courtyard at eye height with the arch in front. Record the placement and perceived scale. The source depth is inferred, so a familiar doorway or chair makes a better scale cue than the numerical coordinate alone. [Viewer controls](https://github.com/StrikeLines/quest-splats-and-3d-models)
4. Perform the tests below from that pose. Keep the PLY as the master. Make a separate delivery copy if you later crop stray splats, simplify the scene, or convert to a compressed format.

## Headset test procedure

Use the same artwork, starting pose, scale, viewer version, and quality setting when comparing runs. Record visual observations inside the headset. A desktop recording cannot establish how the two eye views feel together.

| Test | Procedure | Proposed acceptance criterion |
|---|---|---|
| **Cold start and repeat load** | Time file selection to the first stable stereo frame. Exit VR, reopen the file, and repeat. | Both loads succeed. Record both times and any manual placement adjustments. |
| **Source fidelity and full turn** | Compare the opening view with the source. Turn through 360°, then inspect the floor, ceiling or sky, and panorama seam. | Opening landmark and art style remain recognizable. No conspicuous black wedge, doubled horizon, or seam at the starting position. |
| **Stereo and parallax** | Look through the arch. Lean roughly 10 cm, then 20 cm to each side. Move back to center. Briefly compare the two eye views at the arch edge. | Near and far features shift in the expected order. No distracting double edge or exposed hole within the chosen lean range. Record the first distance and direction where the illusion fails. |
| **Frame delivery** | At the chosen refresh rate, turn slowly for 30 seconds, then lean near the busiest foreground detail for 30 seconds. Record app FPS and dropped frames if available. | Target sustained 72 app FPS at 72 Hz, about 13.9 ms per frame, with smooth turns. Report any dips and reprojection. If instrumentation is unavailable, mark FPS unmeasured and record perceived judder separately. |
| **Scale and comfort** | Inspect a familiar object, look down, recenter, then return to the opening composition. Try seated viewing for a minute with natural head movement. | Horizon stays level, scale feels plausible, and the world stays stationary as the head moves. Record discomfort and stop that trial if it occurs. |
| **Repeatability** | Run once more with cached weights and the same input/settings in a fresh directory. Then try a painted interior or thin foliage as a harder case. | Each run produces a loadable file. Record warm runtime, peak sampled VRAM, splat count, size, and useful lean range per scene. |

The frame target is a design goal. In one published Quest 3 test, PlayCanvas measured about 40 FPS on a large streamed scene even at Performance quality. Scene density, close-up overlap, resolution, and renderer all affect the result. Measure the exact delivery file on the headset. [PlayCanvas Quest 3 measurements](https://blog.playcanvas.com/new-in-supersplat-follow-creators-a-new-home-page-and-enhanced-xr-mode/)

Copy this line into the run notes for each attempt:

```text
Scene / input hash | generator revision / settings | cold or warm | seconds | peak sampled VRAM | splats / MiB | viewer / Quest OS / quality | load seconds | app FPS / dropped frames | useful lean distance | defects | decision
```

## When a test fails

| Observation | Next experiment |
|---|---|
| CUDA import, missing kernel, or undefined symbol on launch | Check the GPU name, driver, toolkit, Torch CUDA build, Python version, and Nunchaku wheel against the setup above. Re-run the smoke test in the isolated environment. For a WSL host, confirm the GPU is visible inside WSL. |
| Gated model download fails | Read the repository ID in the error. Verify the worker account has accepted the terms for that exact checkpoint and can authenticate from the same environment. |
| Generation runs out of memory | Inspect the GPU log for other processes. Unload ComfyUI, retain `--low_vram`, and try `--resolution 1024` in a new output directory. Also check host RAM during CPU offload. Compare the new scene visually. |
| Desktop preview works but Downloads has no usable file | Confirm the output directory exists, `--save_scene` was supplied, and the PLY schema check passes. Compare file sizes before and after transfer. |
| Quest offers a flat browser window only | Use the headset browser, the HTTPS viewer, and its Enter VR action. Try the known-good SuperSplat scene again to isolate headset/session setup from an asset problem. |
| Smooth turns, but holes appear on leaning | Identify the failing edge and record the usable radius. Recompose with fewer thin foreground details, choose an additional authored viewpoint, or use the panorama fallback. |
| Judder while turning even from the center | Reduce viewer quality, then compare a cropped or simplified copy at the same pose. Compression helps transfer size. Fewer visible splats or lower render resolution address drawing cost. |
| Dense scene still performs poorly standalone | On a Windows 5070 Ti host, connect the Quest through USB Link, open the **same PLY** in Splatviewer_VR, and repeat the turn and lean tests. Improved timing implicates the standalone rendering path. Persistent geometric holes implicate the asset. [PC viewer](https://github.com/Enndee/Splatviewer_VR) |

## Second milestone: a two-location gallery

Use the courtyard and a room beyond its door. Give each scene an ID, asset reference, representation (`splat` or `panorama`), starting position and orientation, calibrated scale, and hotspot targets. Keep scene placement and head tracking separate so a change of location preserves the user's natural head movement. With a controller ray, select the doorway, fade out, load the room, place the new origin, and fade in. Include a return hotspot and recenter action. Three.js with Spark is a candidate for a shared splat and panorama viewer. [Spark renderer](https://sparkjs.dev/)

Test courtyard → room → courtyard three times. Only one heavy scene should remain resident after each transition. Check orientation, return placement, load delay, stereo, controller selection, and frame delivery after the last transition. Try the same route with a panorama substituted for one splat. This establishes whether the simpler representation actually costs the artwork anything the viewer notices.

## OffloadMQ integration

The productized Lotus/LDI pipeline uses `world.splat` (not `custom.*`) and OAI
`/app/worlds`. Input is a library image or upload; output is a PLY, preview and
depth map with hashes, settings and timings. Auto mode uses 2:1 inputs as panoramas.
See [VR Worlds](docs/oai-worlds.md) for the final API and lifecycle contract.

OAI copies results into durable storage before releasing temporary buckets and
serves Range-capable scene downloads. Signed HTTPS headset links open without
login. Run the headset turn/lean/FPS trials above before assessing visual quality.
WorldGen's image-to-scene recipe now ships as `world.pano360`: FLUX.1-dev + WorldGen's
public panorama LoRA outpaints the picture into a 360° panorama on the local ComfyUI
(no FLUX Fill, Nunchaku or Linux needed), then Lotus/LDI splats it. See
`examples/vr-world-poc/README.md` for the comparison and
[agent capabilities](docs/agent-capabilities.md#worldpano360--360-worlds-from-one-picture-worldgen-recipe).
Next steps for quality beyond `world.sharp` are in
[docs/worlds-quality-plan.md](docs/worlds-quality-plan.md).
