"""Runtime capability detection.

Each check_*() function returns a CapResult that describes whether a capability
group is available on this system and why. Call detect_capabilities() to run
all checks and get the final list of capability strings to register.
"""

import logging
import shutil
import sys
from typing import Callable, List, NamedTuple

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

    No executor is registered yet — this check is informational only and is
    intentionally excluded from _CHECKS. Add it to _CHECKS once a docker
    executor is implemented.
    """
    import subprocess

    path = shutil.which("docker")
    if not path:
        return CapResult([], False, "docker.*", "docker not found in PATH")
    try:
        r = subprocess.run(
            ["docker", "info"], capture_output=True, timeout=5
        )
        if r.returncode == 0:
            return CapResult(
                [], True, "docker.*",
                f"docker found at {path} and daemon is running (no executor registered yet)",
            )
        return CapResult(
            [], False, "docker.*",
            f"docker found at {path} but daemon is not running (exit {r.returncode})",
        )
    except subprocess.TimeoutExpired:
        return CapResult(
            [], False, "docker.*",
            f"docker found at {path} but 'docker info' timed out",
        )
    except Exception as e:
        return CapResult([], False, "docker.*", f"docker check failed: {e}")


def check_kokoro() -> CapResult:
    import requests
    from .exec.tts import KOKORO_API_URL

    # Derive base URL by stripping the /api/... path suffix
    base = KOKORO_API_URL.split("/api/")[0] if "/api/" in KOKORO_API_URL else KOKORO_API_URL
    try:
        r = requests.get(base, timeout=3)
        return CapResult(
            ["tts.kokoro"], True, "tts.kokoro",
            f"Kokoro API reachable at {base} (HTTP {r.status_code})",
        )
    except requests.RequestException as e:
        return CapResult(
            [], False, "tts.kokoro",
            f"Kokoro API not reachable at {base}: {type(e).__name__}",
        )


def check_ollama() -> CapResult:
    """Check Ollama availability and return one llm.* cap per installed model."""
    import subprocess
    import requests
    from .ollama import OLLAMA_ROOT_URL

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
        res = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, timeout=10
        )
        lines = res.stdout.strip().splitlines()
        models: List[str] = []
        for line in lines[1:]:
            parts = line.split()
            if not parts:
                continue
            name = parts[0]
            if name.endswith(":latest"):
                name = name[:-7]
            models.append(f"llm.{name}")

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
    except subprocess.TimeoutExpired:
        return CapResult([], False, "llm.*", "'ollama list' timed out")
    except Exception as e:
        return CapResult([], False, "llm.*", f"Failed to list Ollama models: {e}")


# ---------------------------------------------------------------------------
# Ordered list of active checks
# ---------------------------------------------------------------------------
# Add check_docker here once a docker executor is implemented.
_CHECKS: List[Callable[[], CapResult]] = [
    check_debug,
    check_bash,
    check_kokoro,
    check_ollama,
]


def detect_capabilities(log_fn=None) -> List[str]:
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
