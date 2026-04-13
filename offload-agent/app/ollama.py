from __future__ import annotations

import json
import logging
import requests
import subprocess
import time
from typing import Callable, List

logger = logging.getLogger(__name__)

_WIN_NO_WINDOW: int = getattr(subprocess, "CREATE_NO_WINDOW", 0)

DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434"

# Module-level constants kept for backward compatibility with external imports.
# All functions in this module use get_ollama_base_url() so they respect config.
OLLAMA_ROOT_URL = f"{DEFAULT_OLLAMA_BASE}/"
OLLAMA_API_URL = f"{DEFAULT_OLLAMA_BASE}/api/chat"
OLLAMA_TAGS_URL = f"{DEFAULT_OLLAMA_BASE}/api/tags"
OLLAMA_SHOW_URL = f"{DEFAULT_OLLAMA_BASE}/api/show"


def get_ollama_base_url() -> str:
    """Return the configured Ollama base URL.

    Reads ``ollamaBaseUrl`` from the agent config.  Falls back to
    ``DEFAULT_OLLAMA_BASE`` (``http://127.0.0.1:11434``) when unset.

    Config key: ``ollamaBaseUrl``
    Example:    ``"http://192.168.1.10:11434"``
    """
    from .config import load_config

    cfg = load_config()
    base = cfg.get("ollamaBaseUrl", "").strip().rstrip("/")
    return base if base else DEFAULT_OLLAMA_BASE


def is_ollama_server_running() -> bool:
    try:
        r = requests.get(f"{get_ollama_base_url()}/", timeout=1)
        return r.status_code == 200 and "Ollama is running" in r.text
    except requests.RequestException:
        return False


def start_ollama_server() -> bool:
    logger.info("Ollama server not found. Attempting to start 'ollama serve'...")
    try:
        subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=_WIN_NO_WINDOW,
        )
        logger.info("'ollama serve' command issued. Waiting for server to initialize...")
        for _ in range(5):
            time.sleep(1)
            if is_ollama_server_running():
                logger.info("Ollama server started successfully.")
                return True
        logger.warning("Failed to detect Ollama server after issuing start command.")
        return False
    except FileNotFoundError:
        logger.warning("'ollama' command not found. Please install Ollama and ensure it is in PATH.")
        return False
    except Exception as e:
        logger.error(f"Unexpected error while starting Ollama: {e}")
        return False


def _format_size(size_bytes: int) -> str:
    """Format a byte count as a human-readable size string (e.g. '4Gb', '512Mb')."""
    gb = size_bytes / (1024 ** 3)
    if gb >= 1:
        rounded = round(gb, 1)
        return f"{rounded:.0f}Gb" if rounded == int(rounded) else f"{rounded}Gb"
    mb = size_bytes / (1024 ** 2)
    return f"{round(mb)}Mb"


def _get_model_extended_attrs(model_name: str) -> List[str]:
    """Query /api/show for a model and return its capability attributes (e.g. ['vision', 'tools']).

    Returns an empty list on any error or if the Ollama version does not expose capabilities.
    """
    try:
        url = f"{get_ollama_base_url()}/api/show"
        r = requests.post(url, json={"name": model_name}, timeout=5)
        if r.status_code != 200:
            return []
        caps = r.json().get("capabilities", [])
        return [c for c in caps if c in ("vision", "tools")]
    except Exception:
        return []


def build_llm_cap_strings() -> List[str]:
    """Fetch all installed Ollama models and build extended OffloadMQ capability strings.

    Each string has the format:  llm.<model>[<attr1>;<attr2>;...]
    Example:                     llm.qwen2.5vl:7b[vision;size:5Gb;tools]

    Attributes are omitted when not available (e.g. older Ollama without /api/show capabilities).
    """
    tags_url = f"{get_ollama_base_url()}/api/tags"
    try:
        r = requests.get(tags_url, timeout=5)
        if r.status_code != 200:
            return []
        models = r.json().get("models", [])
    except Exception as e:
        logger.warning(f"[ollama] Failed to fetch model list from {tags_url}: {e}")
        return []

    cap_strings: List[str] = []
    for model in models:
        full_name = model.get("name", "")
        if not full_name:
            continue

        # Strip :latest suffix for cleaner capability strings
        name = full_name[:-7] if full_name.endswith(":latest") else full_name
        size_bytes = model.get("size", 0)

        extended = _get_model_extended_attrs(full_name)
        attrs: List[str] = []
        if "vision" in extended:
            attrs.append("vision")
        if size_bytes > 0:
            attrs.append(f"size:{_format_size(size_bytes)}")
        if "tools" in extended:
            attrs.append("tools")

        cap = f"llm.{name}"
        if attrs:
            cap += f"[{';'.join(attrs)}]"
        cap_strings.append(cap)

    return cap_strings


def list_ollama_models_raw() -> List[dict[str, object]]:
    """Return raw model list from /api/tags with name, size, size_human, and modified_at.

    Raises RuntimeError if Ollama is unreachable or returns an unexpected response.
    """
    tags_url = f"{get_ollama_base_url()}/api/tags"
    try:
        r = requests.get(tags_url, timeout=5)
        if r.status_code != 200:
            raise RuntimeError(f"Ollama returned HTTP {r.status_code}")
        models = r.json().get("models", [])
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Failed to list Ollama models: {e}") from e

    return [
        {
            "name": m.get("name", ""),
            "size": m.get("size", 0),
            "size_human": _format_size(m.get("size", 0)) if m.get("size") else "",
            "modified_at": m.get("modified_at", ""),
        }
        for m in models
        if m.get("name")
    ]


def delete_ollama_model(name: str) -> None:
    """Delete an installed Ollama model by name.

    Raises RuntimeError on failure. A 404 (model not found) is also treated as an error.
    """
    delete_url = f"{get_ollama_base_url()}/api/delete"
    try:
        r = requests.delete(delete_url, json={"name": name}, timeout=30)
        if r.status_code == 404:
            raise RuntimeError(f"Model '{name}' not found")
        if r.status_code != 200:
            raise RuntimeError(f"Ollama returned HTTP {r.status_code}: {r.text[:200]}")
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Failed to delete model '{name}': {e}") from e


def pull_ollama_model(name: str, progress_fn: Callable[[str], None]) -> None:
    """Pull an Ollama model, calling progress_fn with human-readable status lines.

    Uses the streaming /api/pull endpoint — progress_fn is called for each update.
    Raises RuntimeError on HTTP/connection errors. Any exception raised inside
    progress_fn (e.g. TaskCancelled) propagates naturally to the caller.
    """
    pull_url = f"{get_ollama_base_url()}/api/pull"
    try:
        with requests.post(
            pull_url,
            json={"name": name, "stream": True},
            stream=True,
            timeout=600,
        ) as resp:
            if resp.status_code != 200:
                raise RuntimeError(f"Ollama returned HTTP {resp.status_code}: {resp.text[:200]}")

            for raw_line in resp.iter_lines():
                if not raw_line:
                    continue
                try:
                    data = json.loads(raw_line)
                except ValueError:
                    continue

                if data.get("error"):
                    raise RuntimeError(f"Ollama pull error: {data['error']}")

                status = data.get("status", "")
                total = data.get("total", 0)
                completed = data.get("completed", 0)

                if total and completed:
                    pct = int(completed * 100 / total)
                    progress_fn(f"{status}: {pct}%")
                elif status:
                    progress_fn(status)

    except RuntimeError:
        raise
    except requests.RequestException as e:
        raise RuntimeError(f"Failed to pull model '{name}': {e}") from e


def get_ollama_models() -> List[str]:
    """Return llm.* capability strings for each installed Ollama model.

    Prefer check_ollama() from app.capabilities for startup detection — this
    function is kept for backward compatibility.
    """
    try:
        subprocess.run(["ollama", "--version"], check=True, capture_output=True, creationflags=_WIN_NO_WINDOW)
        res = subprocess.run(
            ["ollama", "list"], check=True, capture_output=True, text=True,
            creationflags=_WIN_NO_WINDOW,
        )
        lines = res.stdout.strip().splitlines()
        if len(lines) < 2:
            return []
        models: List[str] = []
        for line in lines[1:]:
            parts = line.split()
            if not parts:
                continue
            name = parts[0]
            if name.endswith(":latest"):
                name = name[:-7]
            models.append(f"llm.{name}")
        return models
    except FileNotFoundError:
        logger.warning("Ollama is not installed. No LLM capabilities will be added.")
    except subprocess.CalledProcessError as e:
        logger.warning(f"Failed to run 'ollama list': {e.stderr.strip()}")
    except Exception as e:
        logger.warning(f"Error detecting Ollama models: {e}")
    return []
