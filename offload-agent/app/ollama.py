from __future__ import annotations

import logging
import requests
import subprocess
import time
from typing import List

logger = logging.getLogger(__name__)

OLLAMA_API_URL = "http://127.0.0.1:11434/api/chat"
OLLAMA_ROOT_URL = "http://127.0.0.1:11434/"


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
