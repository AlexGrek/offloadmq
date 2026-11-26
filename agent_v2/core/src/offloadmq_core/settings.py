"""Settings JSON management — owned by core."""
from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger(__name__)

SETTINGS_FILE = Path.home() / ".offloadmq-agent.json"

# Shared default for the web UI port — referenced by settings, the systemd
# installer, and both CLI/GUI entry points so there's one place to change it.
DEFAULT_WEBUI_PORT = 8090


class Settings(BaseModel):
    server: str = ""
    api_key: str = ""
    display_name: str = ""
    capabilities: list[str] = []
    custom_caps: list[str] = []
    max_concurrent: int = 1
    autostart: bool = False
    webui_port: int = DEFAULT_WEBUI_PORT

    # Tiered capability policy (v2-native names).
    regular_disabled_caps: list[str] = Field(default_factory=list)
    sensitive_allowed_caps: list[str] = Field(default_factory=list)
    slavemode_allowed_caps: list[str] = Field(default_factory=list)

    # ComfyUI / workflows
    comfyui_url: str = "http://127.0.0.1:8188"
    # Agent-managed local ComfyUI server (see comfy_process.py). --port/--listen
    # are derived from comfyui_url unless given in comfyui_args.
    comfyui_launch_on_startup: bool = False
    comfyui_restart_on_crash: bool = False
    comfyui_python: str = ""
    comfyui_main_py: str = ""
    comfyui_args: list[str] = Field(default_factory=list)

    # Arbitrary Python execution: never enabled by capability discovery alone.
    llm_runtime_enabled: bool = False
    llm_runtime_cache_limit: int = Field(default=8, ge=1)

    ollama_base_url: str = "http://127.0.0.1:11434"

    # Kokoro TTS (OpenAI-compatible speech API)
    kokoro_api_url: str = "https://localhost:8443/v1/audio/speech"
    kokoro_api_key: str = ""

    # Apple SHARP runtime behind world.sharp — installed on demand (omq sharp
    # install / GUI), never with the agent. Blank dirs = ~/.offload-agent/sharp/{venv,models}.
    sharp_venv_dir: str = ""
    sharp_models_dir: str = ""
    sharp_torch_index: str = "auto"  # auto | cuda | cpu | pypi | <index URL>

    # world.pano360 (WorldGen-style 360 outpaint) — models ComfyUI lists; blank = auto-pick.
    # The WorldGen LoRA goes to pano360_lora_dir (blank = ComfyUI's own loras folder).
    pano360_unet: str = ""
    pano360_clip_l: str = ""
    pano360_t5: str = ""
    pano360_vae: str = ""
    pano360_lora_dir: str = ""

    # world.mirror (Tencent WorldMirror 2.0, experimental) — installed on demand (omq mirror
    # install / GUI). Blank dir = ~/.offload-agent/mirror. The HY-World 2.0 licence excludes
    # the EU, UK and South Korea, so nothing is installed or advertised until it is accepted.
    mirror_dir: str = ""
    mirror_license_accepted: bool = False
    # Unload every Ollama model before a run: a loaded LLM pushes WorldMirror out of VRAM
    # (98 s instead of 0.4 s in A1). Turn off when the agent also serves chat.
    mirror_free_ollama: bool = True

    # ONNX models (onnx.nudenet, onnx.bgremove.*) — downloaded on demand. Blank = ~/.offload-agent/onnx-models.
    onnx_models_dir: str = ""
    # Background removal (onnx.bgremove.*) — omq bgremove config / GUI.
    bgremove_device: str = "auto"  # auto | cuda | directml | cpu (onnxruntime execution provider)
    bgremove_threads: int = Field(default=0, ge=0)  # CPU intra-op threads; 0 = onnxruntime default
    bgremove_keep_loaded: bool = True  # keep model sessions in RAM between tasks (~4 GB per BiRefNet)

    # Rescan cadence
    rescan_interval_secs: int = Field(default=180, ge=30)

    # Unattended self-update (Linux CLI under systemd only — see auto_update.py).
    auto_update_enabled: bool = True
    auto_update_interval_hours: int = Field(default=6, ge=1)

    # OS integration flags (persisted; platform modules apply changes).
    win_startup_enabled: bool = False
    mac_startup_enabled: bool = False
    keep_awake_enabled: bool = False
    pause_on_battery: bool = False

    # Internal flags — mark one-time slavemode default seeding as done.
    onnx_slavemode_initialized: bool = False
    ollama_slavemode_initialized: bool = False

    # Credentials populated after registration (not user-edited).
    agent_id: str = ""
    key: str = ""
    jwt_token: str = ""
    token_expires_in: int = 0

    @field_validator(
        "server",
        "api_key",
        "display_name",
        "comfyui_url",
        "comfyui_python",
        "comfyui_main_py",
        "ollama_base_url",
        "kokoro_api_url",
        "kokoro_api_key",
        "sharp_venv_dir",
        "sharp_models_dir",
        "sharp_torch_index",
        "onnx_models_dir",
        "bgremove_device",
        "pano360_unet",
        "pano360_clip_l",
        "pano360_t5",
        "pano360_vae",
        "pano360_lora_dir",
        "mirror_dir",
        mode="before",
    )
    @classmethod
    def _strip(cls, v: Any) -> Any:
        return v.strip() if isinstance(v, str) else v

    @field_validator("max_concurrent", "webui_port", mode="before")
    @classmethod
    def _min_one(cls, v: Any) -> Any:
        try:
            return max(1, int(v))
        except (TypeError, ValueError):
            return 1

    @property
    def is_configured(self) -> bool:
        return bool(self.server and self.api_key)

    @property
    def all_capabilities(self) -> list[str]:
        return [*self.capabilities, *self.custom_caps]


def _backup_path(path: Path) -> Path:
    return path.with_name(path.name + ".bak")


def load_settings(path: Path = SETTINGS_FILE) -> Settings:
    if not path.exists():
        return Settings()
    try:
        return Settings.model_validate(json.loads(path.read_text()))
    except (json.JSONDecodeError, ValueError, OSError) as exc:
        # This is called before the orchestrator's own log buffer/error pool
        # exist, so stderr via logging is the only trace an operator gets that
        # settings (agent_id/key/api_key included) were just silently reset —
        # without it, a corrupt/truncated file looks identical to "never
        # configured" with no way to tell why.
        logger.error("Failed to load settings from %s, using defaults: %s", path, exc)
        bak_path = _backup_path(path)
        if bak_path.exists():
            try:
                recovered = Settings.model_validate(json.loads(bak_path.read_text()))
                logger.error("Recovered settings from backup %s", bak_path)
                return recovered
            except (json.JSONDecodeError, ValueError, OSError) as bak_exc:
                logger.error("Backup %s is also unreadable: %s", bak_path, bak_exc)
        return Settings()


def save_settings(cfg: Settings, path: Path = SETTINGS_FILE) -> None:
    """Snapshot the previous file to ``.bak``, then write atomically.

    A killed/crashed process must never leave a truncated settings file as the
    only copy — writing to a temp file and renaming it over the target is
    atomic on both POSIX and Windows, so a kill mid-write loses the in-flight
    change but never corrupts what's on disk. The ``.bak`` snapshot is the
    second line of defense: it survives even a *logically* bad write (e.g. a
    hand-edited file with the wrong shape), and ``load_settings`` falls back
    to it automatically.
    """
    if path.exists():
        try:
            shutil.copyfile(path, _backup_path(path))
        except OSError as exc:
            logger.warning("Could not snapshot %s to .bak: %s", path, exc)
    tmp_path = path.with_name(path.name + ".tmp")
    # fsync before the rename: without it a crash/power loss can leave the
    # renamed file as zero-filled blocks (NTFS/ext4 delayed allocation), which
    # also gets copied into .bak on the next save.
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(cfg.model_dump_json(indent=2))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, path)
