import json
import sys
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

from app.ollama import *

import typer
from pydantic import BaseModel, Field

CONFIG_FILE = ".offload-agent.json"

def _config_path() -> Path:
    return Path.home() / CONFIG_FILE

def config_exists() -> bool:
    return _config_path().exists()


def load_config() -> Dict[str, Any]:
    p = _config_path()
    if p.exists():
        try:
            result: Dict[str, Any] = json.loads(p.read_text())
            return result
        except (json.JSONDecodeError, OSError) as e:
            typer.echo(f"Warning: Could not load config file: {e}")
    return {}


def save_config(cfg: Dict[str, Any]) -> None:
    try:
        _config_path().write_text(json.dumps(cfg, indent=2))
    except OSError as e:
        typer.echo(f"Error: Could not save config file: {e}")
        sys.exit(1)

