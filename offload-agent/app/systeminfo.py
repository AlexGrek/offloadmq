import json
import hashlib
import platform
import psutil
import re
import subprocess
from typing import Optional, Dict, Any, List, Tuple

from app.ollama import *
from app.tier import (
    AMD_HANDHELD_GPU_KEYWORDS as _AMD_HANDHELD_GPU_KEYWORDS,
    AMD_IGPU_MODEL_KEYWORDS as _AMD_IGPU_MODEL_KEYWORDS,
    calculate_tier,
)

import typer


_WIN_NO_WINDOW: int = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _try_run(cmd: List[str]) -> Tuple[int, str, str]:
    try:
        res = subprocess.run(
            cmd, capture_output=True, text=True, check=False,
            creationflags=_WIN_NO_WINDOW,
        )
        return res.returncode, res.stdout.strip(), res.stderr.strip()
    except Exception as e:
        return 1, "", str(e)


def _mb_to_gb_rounded(mb: int) -> int:
    """Whole gigabytes from a megabyte total (matches server migration rounding)."""
    if mb <= 0:
        return 0
    return max(1, (mb + 512) // 1024)


def _bytes_to_total_memory_gb(memory_bytes: int) -> int:
    return _mb_to_gb_rounded(memory_bytes // (1024 * 1024))


def get_gpu_info() -> Optional[Dict[str, Any]]:
    """Best-effort cross-platform GPU detection.

    Returns: { vendor, model, vramGb } (VRAM is whole gigabytes, 0 if unknown) or None
    """
    # 1) NVIDIA via nvidia-smi (memory.total is MiB)
    rc, out, _ = _try_run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    if rc == 0 and out:
        # Pick the first GPU
        line = out.splitlines()[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2:
            name, mem = parts[0], parts[1]
            try:
                vram_mib = int(float(mem))
            except ValueError:
                vram_mib = 0
            return {"vendor": "NVIDIA", "model": name, "vramGb": _mb_to_gb_rounded(vram_mib)}

    # 2) macOS via system_profiler
    if platform.system() == "Darwin":
        rc, out, _ = _try_run(["system_profiler", "SPDisplaysDataType", "-json"])
        if rc == 0 and out:
            try:
                data = json.loads(out)
                gpus = data.get("SPDisplaysDataType", [])
                if gpus:
                    g = gpus[0]
                    model = g.get("_name") or "GPU"
                    return {"vendor": "Apple/AMD", "model": model, "vramGb": 0}
            except Exception:
                pass

    # 3) Linux via lspci (best effort)
    if platform.system() == "Linux":
        rc, out, _ = _try_run(["bash", "-lc", "lspci -nn | egrep 'VGA|3D' | head -n1"])
        if rc == 0 and out:
            line = out.strip()
            model = line.split(":")[-1].strip() if ":" in line else line
            vendor = "AMD" if "AMD" in model or "Advanced Micro Devices" in model else ("Intel" if "Intel" in model else ("NVIDIA" if "NVIDIA" in model else "Unknown"))
            return {"vendor": vendor, "model": model, "vramGb": 0}

    # 4) Windows via PowerShell CIM (wmic deprecated)
    if platform.system() == "Windows":
        rc, out, _ = _try_run([
            "powershell", "-NoProfile", "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -First 1 Name, AdapterRAM | ConvertTo-Json"
        ])
        if rc == 0 and out:
            try:
                data = json.loads(out)
                if isinstance(data, list):
                    data = data[0] if data else {}
                name = data.get("Name")
                ram = data.get("AdapterRAM")
                vram_mb: int | None = int(ram) // (1024 * 1024) if isinstance(ram, (int, float)) else None
                vendor = "NVIDIA" if name and "NVIDIA" in name.upper() else ("AMD" if name and "AMD" in name.upper() else ("INTEL" if name and "INTEL" in name.upper() else "Unknown"))
                vgb = _mb_to_gb_rounded(vram_mb) if vram_mb is not None else 0
                return {"vendor": vendor.title() if isinstance(vendor, str) else vendor, "model": name, "vramGb": vgb}
            except Exception:
                pass

    return None


def _is_integrated_gpu_for_display(
    gpu: Dict[str, Any], cpu_model: Optional[str]
) -> bool:
    """True when the detected GPU should not be labeled as a dedicated GPU."""
    vu = (gpu.get("vendor") or "").upper()
    mu = (gpu.get("model") or "").upper()
    cu = (cpu_model or "").upper()
    vram = int(gpu.get("vramGb") or 0)

    if "NVIDIA" in vu:
        return False

    if "INTEL" in vu:
        return True
    if "INTEL" in mu and any(
        k in mu for k in ("UHD", "HD GRAPHICS", "IRIS XE", "IRIS(R) XE")
    ):
        return True

    if "APPLE M" in cu:
        if "APPLE" in vu:
            return True
        if any(x in mu for x in ("APPLE M", "M1 ", "M2 ", "M3 ", "M4 ")):
            return True
        if any(x in mu for x in ("M1 ", "M2 ", "M3 ", "M4 ", "M1,", "M2,", "M3,", "M4,")):
            return True

    if "AMD" in vu and vram == 0:
        if any(kw in mu for kw in _AMD_IGPU_MODEL_KEYWORDS) or any(
            kw in mu for kw in _AMD_HANDHELD_GPU_KEYWORDS
        ):
            return True

    if vram == 0 and (
        "INTEGRATED" in mu or "UHD" in mu or "IRIS XE" in mu or "GRAPHICS 6" in mu
    ):
        return True

    return False


def _fit_words(words: List[str], max_len: int) -> str:
    """Join words up to max_len without cutting mid-word."""
    result = ""
    for word in words:
        candidate = f"{result} {word}" if result else word
        if len(candidate) > max_len:
            break
        result = candidate
    return result or words[0] if words else ""


def _shorten_gpu_model_for_display(model: str, max_len: int) -> str:
    """Drop leading vendor fluff so long names fit the display name cap. Never cuts mid-word."""
    words = model.split()
    priority = ("RTX", "GTX", "RX", "ARC", "QUADRO", "RADEON", "GEFORCE")
    for token in priority:
        for i, w in enumerate(words):
            if w.upper() == token:
                return _fit_words(words[i:], max_len)
    return _fit_words(words, max_len)


def _shorten_cpu_for_display(cpu: str) -> str:
    """Strip vendor/generation fluff from CPU brand strings.

    '12th Gen Intel Core i7-12700KF' → 'i7-12700KF'
    'AMD Ryzen 9 5900X 12-Core Processor' → 'Ryzen 9 5900X'
    'Apple M3 Pro' → unchanged
    """
    # Strip Intel generation prefix: "12th Gen", "3rd Gen", etc.
    cpu = re.sub(r"\d+(?:st|nd|rd|th)\s+Gen\s+", "", cpu, flags=re.IGNORECASE)
    # Strip "Intel" and "Core" for Intel CPUs
    if re.search(r"\bIntel\b", cpu, re.IGNORECASE):
        cpu = re.sub(r"\b(?:Intel|Core)\b\s*", "", cpu, flags=re.IGNORECASE)
    # Strip "AMD" prefix (keep Ryzen/EPYC/Threadripper)
    elif re.match(r"^AMD\s+", cpu, re.IGNORECASE):
        cpu = re.sub(r"^AMD\s+", "", cpu, flags=re.IGNORECASE)
    # Strip trailing noise: "12-Core Processor", "Processor"
    cpu = re.sub(r"\s+\d+-Core(\s+Processor)?\b.*$", "", cpu, flags=re.IGNORECASE)
    cpu = re.sub(r"\s+Processor\b.*$", "", cpu, flags=re.IGNORECASE)
    return " ".join(cpu.split())


def _dedicated_gpu_model_label(gpu: Dict[str, Any]) -> str:
    raw = (gpu.get("model") or "").strip()
    raw = raw.replace("(R)", "").replace("(TM)", "").replace(" CPU", "")
    return " ".join(raw.split())


def _trim_base_preserving_ram(base: str, max_len: int) -> str:
    """Shorten base to max_len without cutting a trailing ' 123GB' RAM suffix in half."""
    if len(base) <= max_len:
        return base
    idx = base.rfind(" ")
    if idx > 0 and base.endswith("GB"):
        digits = base[idx + 1 : -2]
        if digits.isdigit():
            ram_suffix = base[idx:]
            cpu_part = base[:idx]
            if len(ram_suffix) <= max_len:
                cpu_room = max_len - len(ram_suffix)
                if cpu_room >= 1:
                    return (cpu_part[:cpu_room].rstrip() + ram_suffix)[:max_len]
    return base[:max_len].rstrip()


def get_cpu_model() -> Optional[str]:
    """Best-effort cross-platform CPU model detection.

    Returns: CPU model string or None
    """
    system = platform.system()

    # macOS (brand_string is empty on some ARM / restricted environments)
    if system == "Darwin":
        rc, out, _ = _try_run(["sysctl", "-n", "machdep.cpu.brand_string"])
        if rc == 0 and out:
            return out
        rc, out, _ = _try_run(["sysctl", "-n", "hw.model"])
        if rc == 0 and out:
            return out

    # Linux
    elif system == "Linux":
        try:
            with open("/proc/cpuinfo", "r") as f:
                for line in f:
                    if line.startswith("model name"):
                        return line.split(":", 1)[1].strip()
        except Exception:
            pass

    # Windows
    elif system == "Windows":
        rc, out, _ = _try_run([
            "powershell", "-NoProfile", "-Command",
            "Get-CimInstance Win32_Processor | Select-Object -First 1 Name | ConvertTo-Json"
        ])
        if rc == 0 and out:
            try:
                data = json.loads(out)
                if isinstance(data, dict) and "Name" in data:
                    name = data.get("Name")
                    if isinstance(name, str):
                        return name
            except Exception:
                pass

    return None


def calculate_machine_id(system_info: Dict[str, Any]) -> str:
    """Calculate deterministic machine ID by hashing all hardware info.

    Returns: First 8 characters of SHA-256 hash
    """
    parts = [
        system_info.get("os", ""),
        system_info.get("cpuArch", ""),
        system_info.get("cpuModel", ""),
        str(system_info.get("totalMemoryGb", "")),
    ]

    gpu = system_info.get("gpu")
    if gpu:
        parts.extend([
            gpu.get("vendor", ""),
            gpu.get("model", ""),
            str(gpu.get("vramGb", "")),
        ])

    combined = "|".join(parts)
    hash_obj = hashlib.sha256(combined.encode())
    return hash_obj.hexdigest()[:8]


def collect_system_info() -> Dict[str, Any]:
    memory_bytes = int(psutil.virtual_memory().total)
    cpu_model = get_cpu_model()

    system_info = {
        "os": platform.system(),
        "cpuArch": platform.machine(),
        "cpuModel": cpu_model,
        "totalMemoryGb": _bytes_to_total_memory_gb(memory_bytes),
        "gpu": get_gpu_info(),
        "client": "offload-agent.py",
        "runtime": "python",
    }

    system_info["machineId"] = calculate_machine_id(system_info)
    return system_info


def compute_default_display_name(sysinfo: Dict[str, Any]) -> str:
    """Build a human-readable display name from system specs.

    Examples: "Apple M3 Pro 16GB", "i9-13900K 48GB RTX 4090 32GB", "Ryzen 9 5900X 32GB RX 6800 XT 16GB"
    Appends " <gpu> <vram>GB" for a discrete GPU (not iGPU); VRAM is always shown (0GB if unknown).
    Result is always <= 50 characters.
    """
    cpu: str = sysinfo.get("cpuModel") or sysinfo.get("cpuArch") or ""
    cpu = cpu.replace("(R)", "").replace("(TM)", "").replace(" CPU", "")
    cpu = " ".join(cpu.split())
    if " @ " in cpu:
        cpu = cpu[:cpu.index(" @ ")]
    cpu = _shorten_cpu_for_display(cpu)
    ram_gb = int(sysinfo.get("totalMemoryGb") or 0)
    base = f"{cpu} {ram_gb}GB" if cpu else f"{ram_gb}GB"

    gpu_raw = sysinfo.get("gpu")
    if not isinstance(gpu_raw, dict):
        return base[:50]
    gpu: Dict[str, Any] = gpu_raw
    if _is_integrated_gpu_for_display(gpu, sysinfo.get("cpuModel")):
        return base[:50]

    dgpu = _dedicated_gpu_model_label(gpu)
    if not dgpu:
        return base[:50]
    # Always strip vendor prefix (e.g. "NVIDIA GeForce RTX 3080 Ti" → "RTX 3080 Ti")
    dgpu = _shorten_gpu_model_for_display(dgpu, max_len=50) or dgpu

    vram_gb = int(gpu.get("vramGb") or 0)
    vram_suffix = f" {vram_gb}GB"

    def full_name(model: str) -> str:
        return f"{base} {model}{vram_suffix}"

    if len(full_name(dgpu)) <= 50:
        return full_name(dgpu)[:50]

    for max_model in (22, 18, 14, 10, 6):
        short_m = _shorten_gpu_model_for_display(dgpu, max_len=max_model)
        if short_m and len(full_name(short_m)) <= 50:
            return full_name(short_m)[:50]

    short_m = _shorten_gpu_model_for_display(dgpu, max_len=6) or "GPU"
    gpu_tail = f"{short_m}{vram_suffix}"
    room = 50 - len(gpu_tail) - 1
    if room >= 6:
        trimmed = _trim_base_preserving_ram(base, room)
        return (trimmed + " " + gpu_tail)[:50]

    return (base[: max(1, 50 - len(gpu_tail) - 1)].rstrip() + " " + gpu_tail)[:50]


def print_system_info(sysinfo: Dict[str, Any]) -> None:
    typer.echo("Collecting system information...")
    typer.echo(f"OS: {sysinfo['os']}")
    typer.echo(f"Architecture: {sysinfo['cpuArch']}")
    if sysinfo.get("cpuModel"):
        typer.echo(f"CPU Model: {sysinfo['cpuModel']}")
    typer.echo(f"Memory: {sysinfo['totalMemoryGb']} GB")
    if sysinfo.get("gpu"):
        g = sysinfo["gpu"]
        typer.echo(f"GPU: {g.get('vendor')} {g.get('model')} ({g.get('vramGb', 0)} GB VRAM)")
    else:
        typer.echo("GPU: None detected")
    if sysinfo.get("machineId"):
        typer.echo(f"Machine ID: {sysinfo['machineId']}")


__all__ = [
    "calculate_machine_id",
    "calculate_tier",
    "collect_system_info",
    "compute_default_display_name",
    "get_cpu_model",
    "get_gpu_info",
    "print_system_info",
]
