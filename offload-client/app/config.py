import json
import sys
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple

from app.ollama import *

import typer
from pydantic import BaseModel, Field

CONFIG_FILE = ".offload-client.json"

def load_config() -> Dict[str, Any]:
    p = Path(CONFIG_FILE)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except (json.JSONDecodeError, OSError) as e:
            typer.echo(f"Warning: Could not load config file: {e}")
    return {}


def save_config(cfg: Dict[str, Any]) -> None:
    try:
        Path(CONFIG_FILE).write_text(json.dumps(cfg, indent=2))
    except OSError as e:
        typer.echo(f"Error: Could not save config file: {e}")
        sys.exit(1)

