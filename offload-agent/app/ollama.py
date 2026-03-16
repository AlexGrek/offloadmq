from __future__ import annotations

import logging
import requests
import subprocess
import time
from typing import List

logger = logging.getLogger(__name__)

OLLAMA_API_URL = "http://127.0.0.1:11434/api/chat"
OLLAMA_ROOT_URL = "http://127.0.0.1:11434/"
OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"
OLLAMA_SHOW_URL = "http://127.0.0.1:11434/api/show"


def is_ollama_server_running() -> bool:
    try:
        r = requests.get(OLLAMA_ROOT_URL, timeout=1)
        return r.status_code == 200 and "Ollama is running" in r.text
    except requests.RequestException:
        return False


def start_ollama_server() -> bool:
    logger.info("Ollama server not found. Attempting to start 'ollama serve'...")
    try:
        subprocess.Popen(
            ["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
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
        r = requests.post(OLLAMA_SHOW_URL, json={"name": model_name}, timeout=5)
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
    try:
        r = requests.get(OLLAMA_TAGS_URL, timeout=5)
        if r.status_code != 200:
            return []
        models = r.json().get("models", [])
    except Exception as e:
        logger.warning(f"[ollama] Failed to fetch model list from {OLLAMA_TAGS_URL}: {e}")
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


def get_ollama_models() -> List[str]:
    """Return llm.* capability strings for each installed Ollama model.

    Prefer check_ollama() from app.capabilities for startup detection — this
    function is kept for backward compatibility.
    """
    try:
        subprocess.run(["ollama", "--version"], check=True, capture_output=True)
        res = subprocess.run(
            ["ollama", "list"], check=True, capture_output=True, text=True
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
