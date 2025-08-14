import json
import platform
import psutil
import subprocess
from typing import Optional, Dict, Any, List, Tuple

from app.ollama import *

import typer

def _try_run(cmd: List[str]) -> Tuple[int, str, str]:
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=False)
        return res.returncode, res.stdout.strip(), res.stderr.strip()
    except Exception as e:
        return 1, "", str(e)


def get_gpu_info() -> Optional[Dict[str, Any]]:
    """Best-effort cross-platform GPU detection.

    Returns: { vendor, model, vramMb } or None
    """
    # 1) NVIDIA via nvidia-smi
    rc, out, _ = _try_run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    if rc == 0 and out:
        # Pick the first GPU
        line = out.splitlines()[0]
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2:
            name, mem = parts[0], parts[1]
            try:
                vram_mb = int(float(mem))
            except ValueError:
                vram_mb = None
            return {"vendor": "NVIDIA", "model": name, "vramMb": vram_mb}

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
                    vram = g.get("spdisplays_vram") or g.get("spdisplays_vram_shared")
                    # system_profiler doesn't give exact MB easily; leave None when unclear
                    return {"vendor": "Apple/AMD", "model": model, "vramMb": None}
            except Exception:
                pass

    # 3) Linux via lspci (best effort)
    if platform.system() == "Linux":
        rc, out, _ = _try_run(["bash", "-lc", "lspci -nn | egrep 'VGA|3D' | head -n1"])
        if rc == 0 and out:
            line = out.strip()
            model = line.split(":")[-1].strip() if ":" in line else line
            vendor = "AMD" if "AMD" in model or "Advanced Micro Devices" in model else ("Intel" if "Intel" in model else ("NVIDIA" if "NVIDIA" in model else "Unknown"))
            return {"vendor": vendor, "model": model, "vramMb": None}

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
                vram_mb = int(ram) // (1024 * 1024) if isinstance(ram, (int, float)) else None
                vendor = "NVIDIA" if name and "NVIDIA" in name.upper() else ("AMD" if name and "AMD" in name.upper() else ("INTEL" if name and "INTEL" in name.upper() else "Unknown"))
                return {"vendor": vendor.title() if isinstance(vendor, str) else vendor, "model": name, "vramMb": vram_mb}
            except Exception:
                pass

    return None


def collect_system_info() -> Dict[str, Any]:
    memory_bytes = psutil.virtual_memory().total
    memory_mb = memory_bytes // (1024 * 1024)
    return {
        "os": platform.system(),
        "cpuArch": platform.machine(),
        "totalMemoryMb": memory_mb,
        "gpu": get_gpu_info(),
        "client": "offload-client.py",
        "runtime": "python",
    }


def print_system_info(sysinfo: Dict[str, Any]) -> None:
    typer.echo("Collecting system information...")
    typer.echo(f"OS: {sysinfo['os']}")
    typer.echo(f"Architecture: {sysinfo['cpuArch']}")
    typer.echo(f"Memory: {sysinfo['totalMemoryMb']} MB")
    if sysinfo.get("gpu"):
        g = sysinfo["gpu"]
        typer.echo(f"GPU: {g.get('vendor')} {g.get('model')} ({g.get('vramMb')} MB VRAM)")
    else:
        typer.echo("GPU: None detected")
