"""Runtime capability detection.

Each check_*() function returns a CapResult that describes whether a capability
group is available on this system and why. Call detect_capabilities() to run
all checks and get the final list of capability strings to register.
"""

import logging
import shutil
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, NamedTuple, Optional

from .httphelpers import HttpClient, update_agent_capabilities
from .config import load_config
from .exec.slavemode import merge_registration_caps, strip_slavemode_caps
from .systeminfo import calculate_tier, collect_system_info

logger = logging.getLogger(__name__)


class CapResult(NamedTuple):
    caps: List[str]  # capability strings to register (empty = unavailable)
    ok: bool         # whether the requirement is met
    label: str       # human-readable label used in log lines
    reason: str      # one-line explanation


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------

def check_debug() -> CapResult:
    return CapResult(
        ["debug.echo"], True,
        "debug.echo",
        "built-in, always available",
    )


def check_bash() -> CapResult:
    if sys.platform == "win32":
        return CapResult(
            [], False,
            "shell.bash, shellcmd.bash",
            "Windows detected — bash is not available on this platform",
        )
    path = shutil.which("bash")
    if path:
        return CapResult(
            ["shell.bash", "shellcmd.bash"], True,
            "shell.bash, shellcmd.bash",
            f"bash found at {path}",
        )
    return CapResult(
        [], False,
        "shell.bash, shellcmd.bash",
        "bash not found in PATH",
    )


def check_docker() -> CapResult:
    """Check docker availability.

    Detects if docker binary is available and daemon is running by executing 'docker ps'.
    If both are available, returns all three docker capability variants.
    """
    import subprocess

    _no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    path = shutil.which("docker")
    if not path:
        return CapResult([], False, "docker.any, docker.python-slim, docker.node", "docker not found in PATH")
    try:
        r = subprocess.run(
            ["docker", "ps"], capture_output=True, timeout=5,
            creationflags=_no_window,
        )
        if r.returncode == 0:
            return CapResult(
                ["docker.any", "docker.python-slim", "docker.node"], True,
                "docker.any, docker.python-slim, docker.node",
                f"docker found at {path} and daemon is running",
            )
        return CapResult(
            [], False, "docker.any, docker.python-slim, docker.node",
            f"docker found at {path} but daemon is not running (exit {r.returncode})",
        )
    except subprocess.TimeoutExpired:
        return CapResult(
            [], False, "docker.any, docker.python-slim, docker.node",
            f"docker found at {path} but 'docker ps' timed out",
        )
    except Exception as e:
        return CapResult([], False, "docker.any, docker.python-slim, docker.node", f"docker check failed: {e}")


def check_kokoro() -> CapResult:
    import requests
    from .exec.tts import KOKORO_API_URL

    base = KOKORO_API_URL.split("/api/")[0] if "/api/" in KOKORO_API_URL else KOKORO_API_URL
    models_url = f"{base}/api/v1/models"

    try:
        r = requests.get(models_url, timeout=3)
        r.raise_for_status()
    except requests.HTTPError:
        return CapResult(
            [], False, "tts.kokoro",
            f"Kokoro /api/v1/models returned HTTP {r.status_code} at {base}",
        )
    except requests.RequestException as e:
        return CapResult(
            [], False, "tts.kokoro",
            f"Kokoro API not reachable at {base}: {type(e).__name__}",
        )

    voices = _parse_kokoro_voices(r)
    if voices:
        cap = f"tts.kokoro[{';'.join(voices)}]"
        reason = f"Kokoro reachable at {base}, voices: {', '.join(voices)}"
    else:
        cap = "tts.kokoro"
        reason = f"Kokoro reachable at {base} (no voice list returned)"

    return CapResult([cap], True, "tts.kokoro", reason)


def _parse_kokoro_voices(response: "Any") -> list[str]:
    """Extract voice/model IDs from a /api/v1/models response, return [] on any parse failure."""
    try:
        data = response.json()
        items = data.get("data", []) if isinstance(data, dict) else []
        return [str(item["id"]) for item in items if isinstance(item, dict) and "id" in item]
    except Exception:
        return []


def check_comfyui() -> CapResult:
    """Check ComfyUI availability and enumerate imggen capabilities from the workflows directory.

    Each subdirectory of workflows/ is a workflow name; .json files inside it (excluding
    *.params.json) identify supported task types.  Produces one extended capability string
    per workflow, e.g. imggen.wan-2.1-outpaint[txt2img;img2img;upscale].
    """
    import requests
    from .exec.imggen.comfyui import comfyui_url
    from .exec.imggen.workflow import _find_workflows_dir

    url = comfyui_url()
    try:
        r = requests.get(f"{url}/system_stats", timeout=3)
        r.raise_for_status()
    except requests.RequestException as e:
        return CapResult(
            [], False,
            "imggen.*",
            f"ComfyUI API not reachable at {url}: {type(e).__name__}",
        )

    workflows_dir = _find_workflows_dir()
    caps = _discover_workflow_caps(workflows_dir)
    if not caps:
        return CapResult(
            [], False,
            "imggen.*",
            f"ComfyUI reachable at {url} but no workflow templates found in {workflows_dir}",
        )

    label = ", ".join(caps)
    return CapResult(
        caps, True,
        "imggen.*",
        f"ComfyUI reachable at {url} — {len(caps)} workflow(s): {label}",
    )


def _discover_workflow_caps(workflows_dir: Path | str) -> list[str]:
    """Scan workflows_dir and return one extended capability string per workflow.

    Skips entries that are not directories or whose names contain path-unsafe characters
    (same rules as _safe_path_component in imggen.py).
    """
    import re
    from pathlib import Path

    safe_re = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
    workflows_dir = Path(workflows_dir)
    caps: list[str] = []

    if not workflows_dir.is_dir():
        return caps

    for entry in sorted(workflows_dir.iterdir()):
        if not entry.is_dir():
            continue
        if not safe_re.match(entry.name):
            continue

        task_types = sorted(
            p.stem
            for p in entry.glob("*.json")
            if not p.name.endswith(".params.json") and safe_re.match(p.stem)
        )
        if not task_types:
            continue

        attrs = ";".join(task_types)
        caps.append(f"imggen.{entry.name}[{attrs}]")

    return caps


def check_custom_caps() -> CapResult:
    """Check for custom capability definitions in the caps directory."""
    from .custom_caps import list_custom_cap_strings, _find_custom_caps_dir

    caps_dir = _find_custom_caps_dir()
    caps = list_custom_cap_strings()
    if caps:
        label = ", ".join(caps)
        return CapResult(
            caps, True,
            "custom.*",
            f"{len(caps)} custom cap(s) in {caps_dir}: {label}",
        )
    return CapResult(
        [], False,
        "custom.*",
        f"No custom capability YAML files found in {caps_dir}",
    )


def check_ollama() -> CapResult:
    """Check Ollama availability and return one extended llm.* cap per installed model.

    Each capability string encodes detected model attributes (vision, size, tools):
        llm.qwen2.5vl:7b[vision;size:5Gb;tools]
    """
    import requests
    from .ollama import OLLAMA_ROOT_URL, build_llm_cap_strings

    if not shutil.which("ollama"):
        return CapResult([], False, "llm.*", "ollama binary not found in PATH")

    try:
        r = requests.get(OLLAMA_ROOT_URL, timeout=2)
        if not (r.status_code == 200 and "Ollama is running" in r.text):
            return CapResult(
                [], False, "llm.*",
                f"Ollama server at {OLLAMA_ROOT_URL} returned unexpected response (HTTP {r.status_code})",
            )
    except requests.RequestException as e:
        return CapResult(
            [], False, "llm.*",
            f"Ollama server not reachable at {OLLAMA_ROOT_URL}: {type(e).__name__}",
        )

    try:
        models = build_llm_cap_strings()
        if models:
            short_names = ", ".join(m[len("llm."):] for m in models)
            return CapResult(
                models, True, "llm.*",
                f"Ollama running with {len(models)} model(s): {short_names}",
            )
        return CapResult(
            [], False, "llm.*",
            "Ollama is running but no models are installed — run 'ollama pull <model>' to add one",
        )
    except Exception as e:
        return CapResult([], False, "llm.*", f"Failed to list Ollama models: {e}")


# ---------------------------------------------------------------------------
# Ordered list of active checks
# ---------------------------------------------------------------------------
_CHECKS: List[Callable[[], CapResult]] = [
    check_debug,
    check_bash,
    check_docker,
    check_kokoro,
    check_comfyui,
    check_custom_caps,
    check_ollama,
]


def detect_capabilities(log_fn: Callable[[str], None] | None = None) -> List[str]:
    """Run all capability checks, log results, and return available capability strings.

    Args:
        log_fn: callable(str) used for logging; defaults to logger.info.

    Returns:
        List of capability strings that passed their runtime check.
    """
    if log_fn is None:
        log_fn = logger.info

    available: List[str] = []
    for check_fn in _CHECKS:
        try:
            result = check_fn()
            if result.ok:
                log_fn(f"[cap] + {result.label}: {result.reason}")
                available.extend(result.caps)
            else:
                log_fn(f"[cap] - {result.label}: {result.reason}")
        except Exception as e:
            log_fn(f"[cap] ! {check_fn.__name__}: unexpected error during check: {e}")

    return available


def compute_registration_caps(
    cfg: Dict[str, Any],
    detected: List[str],
    log_fn: Optional[Callable[[str], None]] = None,
) -> List[str]:
    """Capability list for server registration: saved regular selection filtered by
    detection, plus allow-listed slavemode caps (never from the regular checklist).
    """
    detected_clean = strip_slavemode_caps(list(detected))
    detected_set = set(detected_clean)
    saved = cfg.get("capabilities")
    if saved:
        saved_reg = strip_slavemode_caps(list(saved))
        caps = [c for c in saved_reg if c in detected_set]
        if not caps:
            if log_fn:
                log_fn(
                    "[caps] WARNING: none of the saved capabilities were detected; "
                    "registering with all detected capabilities"
                )
            caps = list(detected_clean)
        elif len(saved_reg) > len(caps) and log_fn:
            dropped = sorted(set(saved_reg) - detected_set)
            log_fn(
                f"[caps] Skipping {len(dropped)} undetected capability(s): {', '.join(dropped)}"
            )
    else:
        caps = list(detected_clean)
    return merge_registration_caps(caps, cfg)


def rescan_and_push(
    http: HttpClient,
    log_fn: Callable[[str], None] | None = None,
) -> List[str]:
    """Detect capabilities and push the updated list to the server.

    Returns the list of detected capability strings.
    """
    if log_fn is None:
        log_fn = logger.info
    cfg = load_config()
    caps = detect_capabilities(log_fn)
    caps = merge_registration_caps(caps, cfg)
    tier: int = cfg.get("tier") or calculate_tier(collect_system_info())
    capacity: int = cfg.get("capacity", 1)
    display_name: str | None = cfg.get("displayName") or None
    update_agent_capabilities(http, caps, tier, capacity, display_name)
    return caps
