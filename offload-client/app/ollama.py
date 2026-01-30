from __future__ import annotations

import requests
import subprocess
import time
from typing import List

import typer

OLLAMA_API_URL = "http://127.0.0.1:11434/api/chat"
OLLAMA_ROOT_URL = "http://127.0.0.1:11434/"


def is_ollama_server_running() -> bool:
    try:
        r = requests.get(OLLAMA_ROOT_URL, timeout=1)
        return r.status_code == 200 and "Ollama is running" in r.text
    except requests.RequestException:
        return False


def start_ollama_server() -> bool:
    typer.echo("Ollama server not found. Attempting to start 'ollama serve'...")
    try:
        subprocess.Popen(
            ["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        typer.echo("'ollama serve' command issued. Waiting for server to initialize...")
        for _ in range(5):
            time.sleep(1)
            if is_ollama_server_running():
                typer.echo("✅ Ollama server started successfully.")
                return True
        typer.echo("❌ Failed to detect Ollama server after issuing start command.")
        return False
    except FileNotFoundError:
        typer.echo(
            "Error: 'ollama' command not found. Please install Ollama and ensure it is in PATH."
        )
        return False
    except Exception as e:
        typer.echo(f"Unexpected error while starting Ollama: {e}")
        return False


def get_ollama_models() -> List[str]:
    try:
        # Verify ollama exists
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
        typer.echo(
            "Warning: Ollama is not installed. No LLM capabilities will be added."
        )
    except subprocess.CalledProcessError as e:
        typer.echo(f"Warning: Failed to run 'ollama list'. Error: {e.stderr.strip()}")
    except Exception as e:
        typer.echo(f"Warning: Error detecting Ollama models: {e}")
    return []
