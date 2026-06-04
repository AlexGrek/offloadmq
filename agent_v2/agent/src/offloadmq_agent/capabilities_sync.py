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

    from offloadmq_agent.kokoro_config import kokoro_base_url, kokoro_verify_tls

    base = kokoro_base_url()
    voices_url = f"{base}/v1/audio/voices"
    verify_tls = kokoro_verify_tls()

    try:
        r = requests.get(voices_url, timeout=3, verify=verify_tls)
        r.raise_for_status()
    except requests.HTTPError:
        return CapResult(
            [], False, "tts.kokoro",
            f"Kokoro /v1/audio/voices returned HTTP {r.status_code} at {base}",
        )
    except requests.RequestException as e:
        return CapResult(
            [], False, "tts.kokoro",
            f"Kokoro API not reachable at {base}: {type(e).__name__}",
        )

    voices = _parse_kokoro_voices(r)
    if voices:
        cap = f"tts.kokoro[{';'.join(voices)}]"
        reason = f"Kokoro reachable at {base}, {len(voices)} voice(s)"
    else:
        cap = "tts.kokoro"
        reason = f"Kokoro reachable at {base} (no voice list returned)"

    return CapResult([cap], True, "tts.kokoro", reason)


def _parse_kokoro_voices(response: "Any") -> list[str]:
    """Extract voice names from a /v1/audio/voices response, return [] on any parse failure."""
    try:
        data = response.json()
        if isinstance(data, dict) and isinstance(data.get("voices"), list):
            return [str(v) for v in data["voices"] if isinstance(v, (str, int))]
        return []
    except Exception:
        return []


def check_comfyui() -> CapResult:
    """Check ComfyUI availability and enumerate imggen/txt2music capabilities.

    imggen:    flat subdirs of workflows/ → imggen.<name>[task_types...]
    txt2music: workflows/txt2music/<name>/ → txt2music.<name>[task_types...]
    """
    import requests

    from offloadmq_agent.exec.imggen.comfyui import comfyui_url
    from offloadmq_agent.exec.imggen.workflow import _find_workflows_dir

    url = comfyui_url()
    try:
        r = requests.get(f"{url}/system_stats", timeout=3)
        r.raise_for_status()
    except requests.RequestException as e:
        return CapResult(
            [], False,
            "imggen.*, txt2music.*",
            f"ComfyUI API not reachable at {url}: {type(e).__name__}",
        )

    workflows_dir = _find_workflows_dir()
    caps = _discover_workflow_caps(workflows_dir)
    if not caps:
        return CapResult(
            [], False,
            "imggen.*, txt2music.*",
            f"ComfyUI reachable at {url} but no workflow templates found in {workflows_dir}",
        )

    label = ", ".join(caps)
    return CapResult(
        caps, True,
        "imggen.*, txt2music.*",
        f"ComfyUI reachable at {url} — {len(caps)} workflow(s): {label}",
    )


# Namespaced capability prefixes that live in a subdirectory of workflows/.
_NAMESPACED_CAP_PREFIXES = ("txt2music",)


def _discover_workflow_caps(workflows_dir: Path | str) -> list[str]:
    """Scan workflows_dir and return one extended capability string per workflow.

    Flat subdirs (not matching a known namespace) → imggen.<name>[task_types...]
    Namespaced subdirs (e.g. txt2music/) → txt2music.<name>[task_types...]
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

        # Namespaced subdirectory (e.g. txt2music/) — recurse one level.
        if entry.name in _NAMESPACED_CAP_PREFIXES:
            caps.extend(_discover_namespaced_caps(entry, namespace=entry.name, safe_re=safe_re))
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


def _discover_namespaced_caps(
    namespace_dir: Path,
    namespace: str,
    safe_re: "Any",
) -> list[str]:
    """Scan a namespace subdirectory and return capability strings like namespace.<name>[types...]."""
    caps: list[str] = []
    for entry in sorted(namespace_dir.iterdir()):
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
        caps.append(f"{namespace}.{entry.name}[{attrs}]")

    return caps


def check_custom_caps() -> CapResult:
    """Check for custom capability definitions in the caps directory."""
    from offloadmq_agent.custom_caps import list_custom_cap_strings, _find_custom_caps_dir

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

    from offloadmq_agent.onnx_models import list_models

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

    from offloadmq_agent.ollama import build_llm_cap_strings, get_ollama_base_url

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
