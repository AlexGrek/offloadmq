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

from .httphelpers import update_agent_capabilities
from .transport import AgentTransport
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


def check_onnx() -> CapResult:
    """Check for downloaded ONNX models and onnxruntime availability.

    Returns one capability per installed model (e.g. onnx.nudenet).
    Only reports models whose files are present on disk — downloading
    is handled separately via slavemode or CLI.
    """
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return CapResult(
            [], False, "onnx.*",
            "onnxruntime not installed — run 'pip install onnxruntime'",
        )

    from .onnx_models import list_models

    models = list_models()
    installed = [m for m in models if m["installed"]]
    if not installed:
        known = ", ".join(m["name"] for m in models)
        return CapResult(
            [], False, "onnx.*",
            f"onnxruntime available but no models downloaded (known: {known})",
        )

    caps = [m["capability"] for m in installed]
    label = ", ".join(caps)
    return CapResult(
        caps, True, "onnx.*",
        f"{len(installed)} ONNX model(s) ready: {label}",
    )


def check_ollama() -> CapResult:
    """Check Ollama availability and return one extended llm.* cap per installed model.

    Each capability string encodes detected model attributes (vision, size, tools):
        llm.qwen2.5vl:7b[vision;size:5Gb;tools]
    """
    import requests
    from .ollama import build_llm_cap_strings, get_ollama_base_url

    if not shutil.which("ollama"):
        return CapResult([], False, "llm.*", "ollama binary not found in PATH")

    base_url = get_ollama_base_url()
    try:
        r = requests.get(f"{base_url}/", timeout=2)
        if not (r.status_code == 200 and "Ollama is running" in r.text):
            return CapResult(
                [], False, "llm.*",
                f"Ollama server at {base_url} returned unexpected response (HTTP {r.status_code})",
            )
    except requests.RequestException as e:
        return CapResult(
            [], False, "llm.*",
            f"Ollama server not reachable at {base_url}: {type(e).__name__}",
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
# Capability tier classification
# ---------------------------------------------------------------------------

def is_sensitive_capability(cap: str) -> bool:
    """Return True if capability requires opt-in (security-sensitive)."""
    return cap.startswith("docker.") or cap.startswith("shell.") or cap.startswith("shellcmd.")


def is_regular_capability(cap: str) -> bool:
    """Return True if capability is regular (opt-out, enabled by default)."""
    # Regular: llm, imggen, tts, debug, custom, onnx
    prefixes = ("llm.", "imggen.", "tts.", "debug.", "custom.", "onnx.")
    return any(cap.startswith(p) for p in prefixes)


def classify_capabilities(caps: List[str]) -> Dict[str, List[str]]:
    """Split capabilities into tiers: regular, sensitive, unknown.

    Returns dict with keys: 'regular', 'sensitive', 'unknown'
    """
    regular = []
    sensitive = []
    unknown = []

    for cap in caps:
        if is_sensitive_capability(cap):
            sensitive.append(cap)
        elif is_regular_capability(cap):
            regular.append(cap)
        else:
            unknown.append(cap)

    return {
        "regular": regular,
        "sensitive": sensitive,
        "unknown": unknown,
    }


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
    check_onnx,
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


# Slavemode caps auto-enabled on first configuration when Ollama is detected.
_OLLAMA_SLAVEMODE_DEFAULTS = [
    "slavemode.ollama-delete",
    "slavemode.ollama-list",
    "slavemode.ollama-pull",
]

_ONNX_SLAVEMODE_DEFAULTS = [
    "slavemode.onnx-models-delete",
    "slavemode.onnx-models-list",
    "slavemode.onnx-models-prepare",
]


def _apply_default_ollama_slavemode(
    cfg: Dict[str, Any],
    detected_caps: List[str],
    log_fn: Optional[Callable[[str], None]] = None,
) -> None:
    """Auto-enable Ollama slavemode caps when Ollama is first detected.

    Runs only when ``slavemode-allowed-caps`` is absent from config (i.e. never
    been set).  If any llm.* capability is detected, the three Ollama management
    caps are written to config immediately so the next registration picks them up.
    """
    from .exec.slavemode import CONFIG_KEY as SLAVEMODE_CONFIG_KEY
    from .config import save_config

    if SLAVEMODE_CONFIG_KEY in cfg:
        return  # User has already configured slavemode — never override

    if not any(c.startswith("llm.") for c in detected_caps):
        return

    cfg[SLAVEMODE_CONFIG_KEY] = sorted(_OLLAMA_SLAVEMODE_DEFAULTS)
    save_config(cfg)
    if log_fn:
        log_fn("[caps] Auto-enabled Ollama slavemode caps (first launch with Ollama detected)")


def _apply_default_onnx_slavemode(
    cfg: Dict[str, Any],
    detected_caps: List[str],
    log_fn: Optional[Callable[[str], None]] = None,
) -> None:
    """Auto-enable ONNX slavemode caps once ONNX runtime is available.

    Uses a separate flag (``_onnx_slavemode_initialized``) so it doesn't conflict
    with the Ollama auto-enable logic that checks for the slavemode key's existence.
    """
    from .exec.slavemode import CONFIG_KEY as SLAVEMODE_CONFIG_KEY
    from .config import save_config

    if cfg.get("_onnx_slavemode_initialized"):
        return

    has_onnx_cap = any(c.startswith("onnx.") for c in detected_caps)
    has_onnx_runtime = False
    if not has_onnx_cap:
        try:
            import onnxruntime  # noqa: F401
            has_onnx_runtime = True
        except ImportError:
            has_onnx_runtime = False

    if not has_onnx_cap and not has_onnx_runtime:
        return

    existing: list[Any] = cfg.get(SLAVEMODE_CONFIG_KEY) or []
    added = [c for c in _ONNX_SLAVEMODE_DEFAULTS if c not in existing]
    if added:
        cfg[SLAVEMODE_CONFIG_KEY] = sorted(set(list(existing) + _ONNX_SLAVEMODE_DEFAULTS))

    cfg["_onnx_slavemode_initialized"] = True
    save_config(cfg)
    if log_fn and added:
        log_fn("[caps] Auto-enabled ONNX slavemode caps (first launch with ONNX runtime available)")


def compute_registration_caps(
    cfg: Dict[str, Any],
    detected: List[str],
    log_fn: Optional[Callable[[str], None]] = None,
) -> List[str]:
    """Compute capabilities for server registration using 3-tier system.

    Tier 1 (Slavemode): Opt-in, separate allow-list (already implemented)
    Tier 2 (Sensitive): Opt-in (docker, shell) - must be explicitly allowed
    Tier 3 (Regular): Opt-out (llm, imggen, tts, debug, custom) - enabled by default unless disabled

    Config keys:
        - sensitive-allowed-caps: List of sensitive caps to allow (opt-in)
        - regular-disabled-caps: List of regular caps to disable (opt-out)
        - capabilities: Legacy key, migrated to tier-based on first use
    """
    detected_clean = strip_slavemode_caps(list(detected))
    detected_set = set(detected_clean)

    # Auto-enable slavemode caps on first configuration
    _apply_default_ollama_slavemode(cfg, detected_clean, log_fn)
    _apply_default_onnx_slavemode(cfg, detected_clean, log_fn)

    # Classify detected capabilities
    classified = classify_capabilities(detected_clean)
    detected_regular = set(classified["regular"])
    detected_sensitive = set(classified["sensitive"])
    detected_unknown = set(classified["unknown"])

    # Migrate legacy config format if needed
    if "capabilities" in cfg and "sensitive-allowed-caps" not in cfg:
        _migrate_legacy_config(cfg, detected_clean, log_fn)

    # Tier 2: Sensitive capabilities (opt-in)
    sensitive_allowed = set(cfg.get("sensitive-allowed-caps", []))
    sensitive_enabled = [c for c in detected_sensitive if c in sensitive_allowed]

    # Tier 3: Regular capabilities (opt-out)
    regular_disabled = set(cfg.get("regular-disabled-caps", []))
    regular_enabled = [c for c in detected_regular if c not in regular_disabled]

    # Unknown capabilities: treat as regular (opt-out)
    unknown_disabled = set(cfg.get("regular-disabled-caps", []))
    unknown_enabled = [c for c in detected_unknown if c not in unknown_disabled]

    # Log warnings for disabled capabilities that aren't detected
    if log_fn:
        for cap in sensitive_allowed:
            if cap not in detected_set:
                log_fn(f"[caps] WARNING: allowed sensitive capability '{cap}' not detected")

        missing_disabled = regular_disabled - detected_set
        if missing_disabled:
            log_fn(f"[caps] NOTE: {len(missing_disabled)} disabled cap(s) not detected: {', '.join(sorted(missing_disabled))}")

    # Combine all enabled capabilities
    caps = regular_enabled + sensitive_enabled + unknown_enabled

    # Tier 1: Merge slavemode allow-listed capabilities
    return merge_registration_caps(caps, cfg)


def _migrate_legacy_config(
    cfg: Dict[str, Any],
    detected_clean: List[str],
    log_fn: Optional[Callable[[str], None]] = None,
) -> None:
    """Migrate legacy 'capabilities' config to tier-based format.

    Old format: capabilities = [list of all selected caps]
    New format:
        - sensitive-allowed-caps = [caps that were selected AND are sensitive]
        - regular-disabled-caps = [regular caps that were NOT selected]
    """
    saved = cfg.get("capabilities", [])
    saved_set = set(strip_slavemode_caps(list(saved)))
    detected_set = set(detected_clean)

    classified = classify_capabilities(detected_clean)
    detected_regular = set(classified["regular"])
    detected_sensitive = set(classified["sensitive"])

    # Sensitive: include only those that were explicitly selected
    sensitive_allowed = [c for c in detected_sensitive if c in saved_set]

    # Regular: disable those that were NOT selected (opt-out model)
    regular_disabled = [c for c in detected_regular if c not in saved_set]

    # Save new format
    cfg["sensitive-allowed-caps"] = sorted(sensitive_allowed)
    cfg["regular-disabled-caps"] = sorted(regular_disabled)

    # Keep legacy key for compatibility (will be ignored going forward)
    # Don't delete it in case user downgrades

    if log_fn:
        log_fn("[caps] Migrated legacy config to tier-based format")
        log_fn(f"[caps]   Sensitive allowed: {len(sensitive_allowed)} cap(s)")
        log_fn(f"[caps]   Regular disabled: {len(regular_disabled)} cap(s)")

    # Save config immediately
    from .config import save_config
    save_config(cfg)


def rescan_and_push(
    transport: AgentTransport,
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
    update_agent_capabilities(transport, caps, tier, capacity, display_name)
    return caps
