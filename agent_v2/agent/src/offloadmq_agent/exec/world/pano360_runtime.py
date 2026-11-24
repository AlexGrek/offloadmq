"""What ``world.pano360`` needs from ComfyUI, and whether it is there.

``world.pano360`` outpaints a picture into a 360° panorama with FLUX.1-dev plus
WorldGen's public panorama LoRA, then splats it like ``world.splat``. Everything
runs inside the ComfyUI the agent already drives, so "installed" means ComfyUI
lists these models::

    FLUX.1-dev UNET   diffusion_models/  any flux dev / krea dev  (pano360_unet, blank = auto)
    CLIP-L            text_encoders/     clip_l*                  (pano360_clip_l, blank = auto)
    T5-XXL            text_encoders/     t5xxl*  (fp8 preferred)  (pano360_t5,     blank = auto)
    FLUX VAE          vae/               ae.safetensors           (pano360_vae,    blank = auto)
    WorldGen LoRA     loras/             worldgen_text2scene.safetensors (35 MB)

Only the LoRA is installed by the agent (``omq pano360 install`` downloads it into
ComfyUI's own ``loras`` folder, or ``pano360_lora_dir``); the FLUX weights are
shared with ordinary image generation and are the operator's to provide.
:func:`status` costs four small ComfyUI requests — cheap enough for every scan.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import requests

from offloadmq_agent.settings_util import load_agent_settings

LORA_NAME = "worldgen_text2scene.safetensors"
LORA_URL = ("https://huggingface.co/LeoXie/WorldGen/resolve/main/"
            "models--WorldGen-Flux-Lora/worldgen_text2scene.safetensors")
LORA_SHA256 = "5349c785650892914b32e74d88d16baa5863981a63a8747b70332e67e0feb10b"
LORA_BYTES = 34_647_632
LORA_LICENSE = "Apache-2.0 (LeoXie/WorldGen on Hugging Face)"
DEFAULT_COMFY_URL = "http://127.0.0.1:8188"

#: role -> (ComfyUI loader node, input holding the model list)
LOADERS: dict[str, tuple[str, str]] = {
    "unet": ("UNETLoader", "unet_name"),
    "clip": ("DualCLIPLoader", "clip_name1"),
    "vae": ("VAELoader", "vae_name"),
    "lora": ("LoraLoaderModelOnly", "lora_name"),
}
#: Every node the outpaint graph uses (checked by ``omq pano360 doctor``).
REQUIRED_NODES = (
    "UNETLoader", "LoraLoaderModelOnly", "ModelSamplingFlux", "DifferentialDiffusion",
    "DualCLIPLoader", "VAELoader", "CLIPTextEncode", "FluxGuidance", "ConditioningZeroOut",
    "LoadImage", "ImageScale", "VAEEncode", "SetLatentNoiseMask", "KSampler", "VAEDecode", "SaveImage",
)
SETTING_KEYS = {"unet": "pano360_unet", "clip_l": "pano360_clip_l", "t5": "pano360_t5", "vae": "pano360_vae"}
_NOT_FLUX_DEV = re.compile(r"fill|kontext|schnell|redux|canny|depth|controlnet", re.IGNORECASE)


def comfy_url(settings: Mapping[str, Any] | None = None) -> str:
    s = load_agent_settings() if settings is None else settings
    return str(s.get("comfyui_url") or DEFAULT_COMFY_URL).rstrip("/")


def combo_options(spec: Any) -> list[str]:
    """A ComfyUI combo input: legacy ``[[...], {...}]`` or ``["COMBO", {"options": [...]}]``."""
    if isinstance(spec, list) and spec:
        if isinstance(spec[0], list):
            return [str(x) for x in spec[0]]
        if spec[0] == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
            return [str(x) for x in spec[1].get("options", [])]
    return []


def comfy_model_lists(url: str, timeout: float = 5.0) -> dict[str, list[str]]:
    """Model names ComfyUI offers per loader. Raises ``requests.RequestException``."""
    lists: dict[str, list[str]] = {}
    for role, (node, field_name) in LOADERS.items():
        r = requests.get(f"{url}/object_info/{node}", timeout=timeout)
        r.raise_for_status()
        info = r.json().get(node) or {}
        lists[role] = combo_options((info.get("input", {}).get("required", {}) or {}).get(field_name))
    return lists


def comfy_lora_dirs(url: str, timeout: float = 5.0) -> list[str]:
    """ComfyUI's ``loras`` search folders (``/internal/folder_paths``), first = default."""
    r = requests.get(f"{url}/internal/folder_paths", timeout=timeout)
    r.raise_for_status()
    dirs = r.json().get("loras") or []
    return [str(d[0] if isinstance(d, list) else d) for d in dirs]


def _base(name: str) -> str:
    return name.replace("\\", "/").rsplit("/", 1)[-1].lower()


def auto_unet(names: list[str]) -> str | None:
    picks = [n for n in names if "flux" in _base(n) and re.search(r"dev|krea", _base(n))
             and not _NOT_FLUX_DEV.search(_base(n))]
    return sorted(picks, key=lambda n: ("krea" not in _base(n), "fp8" not in _base(n), n))[0] if picks else None


def auto_clip_l(names: list[str]) -> str | None:
    picks = [n for n in names if _base(n).startswith("clip_l") and "hidream" not in _base(n)]
    return sorted(picks, key=lambda n: (_base(n) != "clip_l.safetensors", n))[0] if picks else None


def auto_t5(names: list[str]) -> str | None:
    picks = [n for n in names if "t5xxl" in _base(n)]
    return sorted(picks, key=lambda n: ("fp8" not in _base(n), n))[0] if picks else None


def auto_vae(names: list[str]) -> str | None:
    for n in names:
        if _base(n) == "ae.safetensors":
            return n
    picks = [n for n in names if "flux" in _base(n) and ("ae" in _base(n) or "vae" in _base(n))]
    return sorted(picks)[0] if picks else None


def find_lora(names: list[str]) -> str | None:
    return next((n for n in names if _base(n) == LORA_NAME), None)


@dataclass(frozen=True)
class Pano360Models:
    unet: str | None
    clip_l: str | None
    t5: str | None
    vae: str | None
    lora: str | None

    def to_dict(self) -> dict[str, str | None]:
        return {"unet": self.unet, "clip_l": self.clip_l, "t5": self.t5, "vae": self.vae, "lora": self.lora}


def pick_models(lists: Mapping[str, list[str]], settings: Mapping[str, Any]) -> tuple[Pano360Models, list[str]]:
    """Resolve each model (explicit setting, else auto). Returns ``(models, problems)``."""
    problems: list[str] = []

    def resolve(role: str, key: str, auto: Any, what: str) -> str | None:
        names = list(lists.get(key, []))
        wanted = str(settings.get(SETTING_KEYS[role]) or "").strip()
        if wanted:
            if wanted in names:
                return wanted
            problems.append(f"{what} '{wanted}' ({SETTING_KEYS[role]}) is not in ComfyUI")
            return None
        got: str | None = auto(names)
        if got is None:
            problems.append(f"no {what} in ComfyUI")
        return got

    models = Pano360Models(
        unet=resolve("unet", "unet", auto_unet, "FLUX.1-dev UNET"),
        clip_l=resolve("clip_l", "clip", auto_clip_l, "CLIP-L text encoder"),
        t5=resolve("t5", "clip", auto_t5, "T5-XXL text encoder"),
        vae=resolve("vae", "vae", auto_vae, "FLUX VAE (ae.safetensors)"),
        lora=find_lora(list(lists.get("lora", []))),
    )
    if models.lora is None:
        problems.append(f"WorldGen LoRA {LORA_NAME} missing; run `omq pano360 install`")
    return models, problems


@dataclass(frozen=True)
class Pano360Status:
    url: str
    reachable: bool
    models: Pano360Models
    problems: list[str] = field(default_factory=list)
    lists: dict[str, list[str]] = field(default_factory=dict)
    error: str | None = None

    @property
    def ready(self) -> bool:
        return self.reachable and not self.problems

    def describe(self) -> str:
        if not self.reachable:
            return f"ComfyUI API not reachable at {self.url}: {self.error}"
        if self.problems:
            return "; ".join(self.problems)
        return f"FLUX {self.models.unet} + {self.models.lora} at {self.url}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "ready": self.ready, "comfyui_url": self.url, "reachable": self.reachable,
            "models": self.models.to_dict(), "problems": list(self.problems), "summary": self.describe(),
            "choices": {"unet": [n for n in self.lists.get("unet", []) if "flux" in _base(n)] or self.lists.get("unet", []),
                        "clip_l": self.lists.get("clip", []), "t5": [n for n in self.lists.get("clip", []) if "t5" in _base(n)],
                        "vae": self.lists.get("vae", [])},
        }


def status(settings: Mapping[str, Any] | None = None, timeout: float = 3.0) -> Pano360Status:
    s = load_agent_settings() if settings is None else settings
    url = comfy_url(s)
    empty = Pano360Models(None, None, None, None, None)
    try:
        lists = comfy_model_lists(url, timeout)
    except (requests.RequestException, ValueError) as e:
        return Pano360Status(url, False, empty, error=type(e).__name__)
    models, problems = pick_models(lists, s)
    return Pano360Status(url, True, models, problems, lists)


def lora_target_dir(settings: Mapping[str, Any] | None = None, timeout: float = 5.0) -> Path:
    """Where ``install`` puts the LoRA: ``pano360_lora_dir``, else ComfyUI's first ``loras`` folder."""
    s = load_agent_settings() if settings is None else settings
    explicit = str(s.get("pano360_lora_dir") or "").strip()
    if explicit:
        return Path(explicit).expanduser()
    try:
        dirs = comfy_lora_dirs(comfy_url(s), timeout)
    except (requests.RequestException, ValueError) as e:
        raise RuntimeError(
            f"cannot ask ComfyUI at {comfy_url(s)} for its loras folder ({type(e).__name__}); "
            "start ComfyUI or set pano360_lora_dir"
        ) from e
    if not dirs:
        raise RuntimeError("ComfyUI reported no loras folder; set pano360_lora_dir")
    existing = [d for d in dirs if Path(d).is_dir()]
    return Path((existing or dirs)[0])
