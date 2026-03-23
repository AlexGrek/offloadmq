from typing import Optional, Dict, Any


def calculate_tier(system_info: Dict[str, Any]) -> int:
    """Calculate performance tier (1-5) from collected system info.

    Tier 5: NVIDIA GPU with 12GB+ dedicated VRAM, or NVIDIA shared-memory GPU
            on a system with more than 16GB RAM (special AI computers)
    Tier 4: Any GPU with 8GB+ VRAM, or Apple/Intel/Snapdragon CPU with 32GB+ RAM
    Tier 3: Apple M-series with more than 20GB RAM,
            or AMD handheld APU (Van Gogh/Aerith/Sephiroth/Z-series) with 12–16GB RAM
    Tier 2: 12–16GB RAM, dedicated GPU with 4GB+ VRAM, or modern AMD iGPU (Vega/RDNA on Zen APU)
    Tier 1: Everything else
    """
    ram_mb: int = system_info.get("totalMemoryMb") or 0
    ram_gb: float = ram_mb / 1024

    gpu: Optional[Dict[str, Any]] = system_info.get("gpu")
    cpu_model: str = (system_info.get("cpuModel") or "").upper()

    vendor: str = (gpu.get("vendor") or "").upper() if gpu else ""
    vram_mb: int = (gpu.get("vramMb") or 0) if gpu else 0
    vram_gb: float = vram_mb / 1024

    gpu_model: str = (gpu.get("model") or "").upper() if gpu else ""

    is_nvidia = "NVIDIA" in vendor
    has_dedicated_vram = gpu is not None and vram_mb > 0
    is_apple_m = "APPLE M" in cpu_model
    is_intel = "INTEL" in cpu_model
    is_snapdragon = "SNAPDRAGON" in cpu_model

    # Modern AMD iGPU (Vega / RDNA on Zen APUs — handhelds, mini-PCs).
    # These report no dedicated VRAM because they use shared system memory.
    _AMD_IGPU_KEYWORDS = ("VEGA", "RDNA", "680M", "760M", "780M", "890M",
                          "VAN GOGH", "REMBRANDT", "PHOENIX", "STRIX", "HAWK POINT")
    is_amd_modern_igpu = (
        "AMD" in vendor
        and not has_dedicated_vram
        and any(kw in gpu_model for kw in _AMD_IGPU_KEYWORDS)
    )

    # AMD handheld APU — gaming handheld devices (Steam Deck, ROG Ally, Legion Go, etc.).
    # CPU detection: "AMD Custom APU" = Steam Deck; "Ryzen Z" = all AMD Z-series
    #   handheld branding (Z1, Z1 Extreme, Z2, Z2 Extreme, Z2G) — never used on laptops.
    # GPU detection: Van Gogh / Custom GPU IDs = Steam Deck original + OLED (Sephiroth).
    #   Z-series devices (Phoenix / Hawk Point / Strix Point) are caught by CPU model above.
    _HANDHELD_CPU_KEYWORDS = ("AMD CUSTOM APU", "RYZEN Z")
    _HANDHELD_GPU_KEYWORDS = ("VANGOGH", "VAN GOGH", "CUSTOM GPU 0405", "CUSTOM GPU 0932")
    is_amd_handheld = any(kw in cpu_model for kw in _HANDHELD_CPU_KEYWORDS) or (
        "AMD" in vendor
        and not has_dedicated_vram
        and any(kw in gpu_model for kw in _HANDHELD_GPU_KEYWORDS)
    )

    # Tier 5: NVIDIA with 12GB+ dedicated VRAM
    if is_nvidia and has_dedicated_vram and vram_gb >= 12:
        return 5

    # Tier 5: NVIDIA with shared memory on system with 16GB+ RAM
    if is_nvidia and not has_dedicated_vram and ram_gb > 16:
        return 5

    # Tier 4: any GPU with 8GB+ VRAM
    if gpu and vram_gb >= 8:
        return 4

    # Tier 4: Apple / Intel / Snapdragon with 32GB+ RAM
    if (is_apple_m or is_intel or is_snapdragon) and ram_gb > 32:
        return 4

    # Tier 3: Apple M-series with more than 20GB RAM
    if is_apple_m and ram_gb > 20:
        return 3

    # Tier 3: AMD handheld APU with 12–16GB shared RAM
    if is_amd_handheld and 12 <= ram_gb <= 16:
        return 3

    # Tier 2: dedicated GPU with 4GB+ VRAM
    if has_dedicated_vram and vram_gb >= 4:
        return 2

    # Tier 2: modern AMD iGPU (Vega/RDNA on Zen APU — handhelds, mini-PCs)
    if is_amd_modern_igpu:
        return 2

    # Tier 2: 12–16GB RAM
    if 12 <= ram_gb <= 16:
        return 2

    return 1
