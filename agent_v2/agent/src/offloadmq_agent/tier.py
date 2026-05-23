import re
from typing import Optional, Dict, Any, Tuple

# Shared with systeminfo (display names) and tier scoring.
AMD_IGPU_MODEL_KEYWORDS: Tuple[str, ...] = (
    "VEGA",
    "RDNA",
    "680M",
    "760M",
    "780M",
    "890M",
    "VAN GOGH",
    "REMBRANDT",
    "PHOENIX",
    "STRIX",
    "HAWK POINT",
)
AMD_HANDHELD_GPU_KEYWORDS: Tuple[str, ...] = (
    "VANGOGH",
    "VAN GOGH",
    "CUSTOM GPU 0405",
    "CUSTOM GPU 0932",
)


def _intel_core_gen(cpu_model: str) -> Optional[int]:
    """Return the Intel Core generation number, or None if not detectable.

    Handles: 'i5-8400T', 'Core i7-13700K', 'Intel Core i9-14900KS', etc.
    The generation is the leading digits of the 4-5 digit model number:
      8400  → gen  8
      11600 → gen 11
      13700 → gen 13
    """
    m = re.search(r"\bi[3579]-(\d{4,5})", cpu_model, re.IGNORECASE)
    if not m:
        return None
    digits = m.group(1)
    # 4-digit: first digit is gen (e.g. 8400 → 8); 5-digit: first two (e.g. 13700 → 13)
    return int(digits[:-3])


def _intel_core_series(cpu_model: str) -> Optional[int]:
    """Return 3, 5, 7, or 9 for Intel Core i3/i5/i7/i9, else None."""
    m = re.search(r"\bi([3579])-\d{4,5}", cpu_model, re.IGNORECASE)
    return int(m.group(1)) if m else None


def calculate_tier(system_info: Dict[str, Any]) -> int:
    """Calculate performance tier (1-5) from collected system info.

    RAM and GPU VRAM are whole gigabytes (totalMemoryGb, gpu.vramGb).

    Tier 5: NVIDIA GPU with 12GB+ dedicated VRAM, or NVIDIA shared-memory GPU
            on a system with more than 16GB RAM (special AI computers)
    Tier 4: Any GPU with 8GB+ VRAM, or Apple/Intel/Snapdragon CPU with 32GB+ RAM
    Tier 3: Apple M-series with more than 20GB RAM,
            or AMD handheld APU (Van Gogh/Aerith/Sephiroth/Z-series) with 12-16GB RAM
    Tier 2: 12-16GB RAM, dedicated GPU with 4GB+ VRAM, or modern AMD iGPU (Vega/RDNA on Zen APU)
    Tier 1: Everything else
    """
    ram_gb: int = int(system_info.get("totalMemoryGb") or 0)

    gpu: Optional[Dict[str, Any]] = system_info.get("gpu")
    cpu_model: str = (system_info.get("cpuModel") or "").upper()

    vendor: str = (gpu.get("vendor") or "").upper() if gpu else ""
    vram_gb: int = int(gpu.get("vramGb") or 0) if gpu else 0

    gpu_model: str = (gpu.get("model") or "").upper() if gpu else ""

    is_nvidia = "NVIDIA" in vendor
    has_dedicated_vram = gpu is not None and vram_gb > 0
    is_apple_m = "APPLE M" in cpu_model
    is_intel = "INTEL" in cpu_model
    is_snapdragon = "SNAPDRAGON" in cpu_model

    # Modern AMD iGPU (Vega / RDNA on Zen APUs -- handhelds, mini-PCs).
    # These report no dedicated VRAM because they use shared system memory.
    is_amd_modern_igpu = (
        "AMD" in vendor
        and not has_dedicated_vram
        and any(kw in gpu_model for kw in AMD_IGPU_MODEL_KEYWORDS)
    )

    # AMD handheld APU -- gaming handheld devices (Steam Deck, ROG Ally, Legion Go, etc.).
    _HANDHELD_CPU_KEYWORDS = ("AMD CUSTOM APU", "RYZEN Z")
    is_amd_handheld = any(kw in cpu_model for kw in _HANDHELD_CPU_KEYWORDS) or (
        "AMD" in vendor
        and not has_dedicated_vram
        and any(kw in gpu_model for kw in AMD_HANDHELD_GPU_KEYWORDS)
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

    # Tier 3: AMD handheld APU with 12-16GB shared RAM
    if is_amd_handheld and 12 <= ram_gb <= 16:
        return 3

    # Tier 2: dedicated GPU with 4GB+ VRAM
    if has_dedicated_vram and vram_gb >= 4:
        return 2

    # Tier 2: modern AMD iGPU (Vega/RDNA on Zen APU -- handhelds, mini-PCs)
    if is_amd_modern_igpu:
        return 2

    # Intel Core generation-based tiers (iGPU-only; discrete GPU already handled above).
    # i7 13th gen+ → Tier 3; i5 11th gen+ → Tier 2; older Intel → Tier 1.
    if is_intel and not has_dedicated_vram:
        intel_gen = _intel_core_gen(cpu_model)
        intel_series = _intel_core_series(cpu_model)
        if intel_gen is not None and intel_series is not None:
            if intel_series >= 7 and intel_gen >= 13:
                return 3
            if intel_series >= 5 and intel_gen >= 11:
                return 2
            return 1

    # Tier 2: 12-16GB RAM
    if 12 <= ram_gb <= 16:
        return 2

    return 1
