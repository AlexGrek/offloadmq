"""Custom capability definitions stored as YAML files.

Each YAML file defines a custom capability with typed parameters. The ``type``
field selects the execution backend:

  shell  — runs a bash script; parameters are injected as CUSTOM_* env vars
  llm    — renders a prompt template and sends it to Ollama

Shell custom caps (type: shell)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Parameters are passed as environment variables with a CUSTOM_ prefix, preventing
shell injection — the script is trusted (authored by agent operator), only
parameter VALUES come from untrusted task submitters.

    name: deploy-app
    type: shell
    description: Deploy the application
    script: |
      #!/bin/bash
      set -euo pipefail
      echo "Deploying $CUSTOM_BRANCH"
    params:
      - name: branch
        type: string
        default: main
    timeout: 120
    env:
      DEPLOY_KEY: /path/to/key

LLM custom caps (type: llm)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Parameters are substituted into a prompt template using {{param}} syntax.
The rendered prompt is sent to a local Ollama model.

    name: summarize
    type: llm
    description: Summarize text
    model: mistral:7b
    prompt: |
      Summarize the following text in {{style}} style:
      {{text}}
    system: You are a helpful assistant.
    temperature: 0.7
    max_tokens: 1024
    params:
      - name: text
        type: text
      - name: style
        type: string
        default: concise
"""

import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_SAFE_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*$')
_PARAM_NAME_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_]*$')

_VALID_TYPES = {"string", "int", "integer", "float", "number", "double", "bool", "boolean", "text", "json", "object"}
VALID_EXEC_TYPES = {"shell", "llm"}

# Type hint aliases → canonical form used in capability attribute strings
_TYPE_CANONICAL = {
    "string": None,   # default, no suffix needed
    "int": "int",
    "integer": "int",
    "float": "float",
    "number": "float",
    "double": "float",
    "bool": "bool",
    "boolean": "bool",
    "text": "text",
    "json": "json",
    "object": "json",
}


class CustomParam:
    """A single parameter defined in a custom capability YAML."""

    __slots__ = ("name", "type", "default", "description")

    def __init__(self, name: str, type_: str = "string", default: Optional[str] = None, description: str = ""):
        if not _PARAM_NAME_RE.match(name):
            raise ValueError(
                f"Invalid param name '{name}': must start with a letter "
                "and contain only letters, digits, underscores"
            )
        type_lower = type_.lower()
        if type_lower not in _VALID_TYPES:
            raise ValueError(f"Invalid param type '{type_}' for '{name}': must be one of {sorted(_VALID_TYPES)}")
        self.name = name
        self.type = type_lower
        self.default = default
        self.description = description

    def env_name(self) -> str:
        """Environment variable name for this parameter."""
        return f"CUSTOM_{self.name.upper()}"

    def capability_attr(self) -> str:
        """Attribute string for the capability extended notation."""
        canonical = _TYPE_CANONICAL.get(self.type)
        if canonical:
            return f"{self.name}:{canonical}"
        return self.name

    def coerce(self, value: str) -> str:
        """Validate and return the string representation for env var.

        All values are passed as strings in environment variables.
        Validation ensures the value matches the declared type.
        """
        if not isinstance(value, str):
            value = str(value)
        t = self.type
        if t in ("int", "integer"):
            try:
                int(value)
            except (ValueError, TypeError):
                raise ValueError(f"Parameter '{self.name}' must be an integer, got '{value}'")
        elif t in ("float", "number", "double"):
            try:
                float(value)
            except (ValueError, TypeError):
                raise ValueError(f"Parameter '{self.name}' must be a number, got '{value}'")
        elif t in ("bool", "boolean"):
            if value.lower() not in ("true", "false", "1", "0", "yes", "no"):
                raise ValueError(f"Parameter '{self.name}' must be a boolean, got '{value}'")
            # Normalise to "true"/"false"
            value = "true" if value.lower() in ("true", "1", "yes") else "false"
        # string, text, json, object — pass through as-is
        return value


class CustomCap:
    """A loaded custom capability definition."""

    __slots__ = (
        "name", "description", "exec_type", "script", "params", "timeout", "env", "path",
        # LLM-specific fields
        "model", "prompt", "system", "temperature", "max_tokens",
    )

    def __init__(
        self,
        name: str,
        description: str,
        exec_type: str = "shell",
        script: Optional[str] = None,
        params: Optional[List[CustomParam]] = None,
        timeout: int = 120,
        env: Optional[Dict[str, str]] = None,
        path: Optional[Path] = None,
        # LLM-specific
        model: Optional[str] = None,
        prompt: Optional[str] = None,
        system: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ):
        self.name = name
        self.description = description
        self.exec_type = exec_type
        self.script = script
        self.params = params or []
        self.timeout = timeout
        self.env = env or {}
        self.path = path
        self.model = model
        self.prompt = prompt
        self.system = system
        self.temperature = temperature
        self.max_tokens = max_tokens

    def capability_string(self) -> str:
        """Build the extended capability string, e.g. custom.deploy-app[branch;env;dry_run:bool]."""
        base = f"custom.{self.name}"
        if not self.params:
            return base
        attrs = ";".join(p.capability_attr() for p in self.params)
        return f"{base}[{attrs}]"

    def _resolve_params(self, payload: Dict[str, Any]) -> Dict[str, str]:
        """Resolve parameter values from payload, applying defaults and coercion.

        Returns dict of {param_name: coerced_string_value}.
        Raises ValueError if a required parameter (no default) is missing.
        """
        resolved: Dict[str, str] = {}
        for param in self.params:
            raw = payload.get(param.name)
            if raw is None or (isinstance(raw, str) and raw.strip() == ""):
                if param.default is not None:
                    raw = param.default
                else:
                    raise ValueError(f"Required parameter '{param.name}' is missing")
            resolved[param.name] = param.coerce(str(raw))
        return resolved

    def build_env(self, payload: Dict[str, Any]) -> Dict[str, str]:
        """Build the environment dict for shell script execution.

        Merges OS environ + static cap env + CUSTOM_* parameter values.
        Returns a complete env dict suitable for subprocess.

        Raises ValueError if a required parameter (no default) is missing.
        """
        env = dict(os.environ)
        # Static env vars from capability definition
        env.update(self.env)

        resolved = self._resolve_params(payload)
        for name, value in resolved.items():
            env[f"CUSTOM_{name.upper()}"] = value

        return env

    def render_prompt(self, payload: Dict[str, Any]) -> str:
        """Render the prompt template with parameter values substituted.

        Uses {{param_name}} placeholders. Safe for LLM prompts — no shell
        execution involved.

        Raises ValueError if a required parameter is missing.
        """
        if not self.prompt:
            raise ValueError("LLM custom cap has no 'prompt' template")

        resolved = self._resolve_params(payload)
        result = self.prompt
        for name, value in resolved.items():
            result = result.replace("{{" + name + "}}", value)
        return result

    def to_dict(self) -> Dict[str, Any]:
        """Serialize for API/UI consumption."""
        d: Dict[str, Any] = {
            "name": self.name,
            "type": self.exec_type,
            "description": self.description,
            "params": [
                {
                    "name": p.name,
                    "type": p.type,
                    "default": p.default,
                    "description": p.description,
                }
                for p in self.params
            ],
            "timeout": self.timeout,
            "capability": self.capability_string(),
        }
        if self.exec_type == "shell":
            d["script"] = self.script
            if self.env:
                d["env"] = self.env
        elif self.exec_type == "llm":
            d["prompt"] = self.prompt
            if self.model:
                d["model"] = self.model
            if self.system:
                d["system"] = self.system
            if self.temperature is not None:
                d["temperature"] = self.temperature
            if self.max_tokens is not None:
                d["max_tokens"] = self.max_tokens
        return d


# ---------------------------------------------------------------------------
# Discovery and loading
# ---------------------------------------------------------------------------

def _find_custom_caps_dir() -> Path:
    """Locate the custom capabilities directory, persisting across PyInstaller rebuilds.

    Priority:
    1. Environment variable OFFLOAD_CUSTOM_CAPS_DIR
    2. ~/.offload-agent/skills (persistent default; directory name kept for backward compatibility)
    3. CWD/skills (explicit local setup)
    """
    if env_dir := os.getenv("OFFLOAD_CUSTOM_CAPS_DIR"):
        env_path = Path(env_dir)
        if env_path.is_dir():
            return env_path

    home_dir = Path.home() / ".offload-agent" / "skills"
    if home_dir.is_dir():
        return home_dir

    cwd_dir = Path.cwd() / "skills"
    if cwd_dir.is_dir():
        return cwd_dir

    # Create the persistent home directory
    home_dir.mkdir(parents=True, exist_ok=True)
    return home_dir


def load_custom_cap(path: Path) -> CustomCap:
    """Load a single custom capability from a YAML file.

    Raises ValueError on validation errors, FileNotFoundError if missing.
    """
    import yaml

    if not path.is_file():
        raise FileNotFoundError(f"Custom cap file not found: {path}")

    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"Custom cap file must be a YAML mapping: {path}")

    name = raw.get("name")
    if not name or not _SAFE_NAME_RE.match(str(name)):
        raise ValueError(
            f"Custom cap 'name' is required and must match [A-Za-z0-9._-]: {path}"
        )

    description = raw.get("description", "")
    exec_type = str(raw.get("type", "shell")).lower()
    if exec_type not in VALID_EXEC_TYPES:
        raise ValueError(
            f"Custom cap 'type' must be one of {sorted(VALID_EXEC_TYPES)}, got '{exec_type}': {path}"
        )

    timeout = int(raw.get("timeout", 120))
    if timeout < 1 or timeout > 86400:
        raise ValueError(f"Custom cap 'timeout' must be 1-86400 seconds: {path}")

    params: List[CustomParam] = []
    raw_params = raw.get("params")
    if raw_params and isinstance(raw_params, list):
        for p in raw_params:
            if not isinstance(p, dict):
                raise ValueError(f"Each param must be a mapping: {path}")
            params.append(CustomParam(
                name=p["name"],
                type_=p.get("type", "string"),
                default=str(p["default"]) if "default" in p and p["default"] is not None else None,
                description=p.get("description", ""),
            ))

    # Type-specific validation
    script = None
    static_env: Dict[str, str] = {}
    model = None
    prompt = None
    system = None
    temperature = None
    max_tokens = None

    if exec_type == "shell":
        script = raw.get("script")
        if not script or not isinstance(script, str):
            raise ValueError(f"Shell custom cap 'script' is required and must be a string: {path}")
        raw_env = raw.get("env")
        if raw_env and isinstance(raw_env, dict):
            static_env = {str(k): str(v) for k, v in raw_env.items()}

    elif exec_type == "llm":
        prompt = raw.get("prompt")
        if not prompt or not isinstance(prompt, str):
            raise ValueError(f"LLM custom cap 'prompt' is required and must be a string: {path}")
        model = raw.get("model")
        if not model:
            raise ValueError(f"LLM custom cap 'model' is required: {path}")
        system = raw.get("system")
        if raw.get("temperature") is not None:
            temperature = float(raw["temperature"])
        if raw.get("max_tokens") is not None:
            max_tokens = int(raw["max_tokens"])

    return CustomCap(
        name=str(name),
        description=str(description),
        exec_type=exec_type,
        script=script,
        params=params,
        timeout=timeout,
        env=static_env,
        path=path,
        model=model,
        prompt=prompt,
        system=system,
        temperature=temperature,
        max_tokens=max_tokens,
    )


def discover_custom_caps() -> List[CustomCap]:
    """Scan the custom caps directory and return all valid definitions."""
    caps_dir = _find_custom_caps_dir()
    if not caps_dir.is_dir():
        return []

    caps: List[CustomCap] = []
    for entry in sorted(caps_dir.iterdir()):
        if entry.suffix not in (".yaml", ".yml"):
            continue
        if not entry.is_file():
            continue
        try:
            cap = load_custom_cap(entry)
            caps.append(cap)
        except Exception as e:
            logger.warning(f"Skipping invalid custom cap {entry.name}: {e}")

    return caps


def list_custom_cap_strings() -> List[str]:
    """Return capability strings for all discovered custom caps."""
    return [c.capability_string() for c in discover_custom_caps()]


def get_custom_cap(capability: str) -> Optional[CustomCap]:
    """Find and load the custom cap matching a base capability like 'custom.deploy-app'.

    The capability should already have extended attributes stripped.
    """
    if not capability.startswith("custom."):
        return None

    cap_name = capability[len("custom."):]
    if not cap_name or not _SAFE_NAME_RE.match(cap_name):
        return None

    caps_dir = _find_custom_caps_dir()
    for suffix in (".yaml", ".yml"):
        path = caps_dir / f"{cap_name}{suffix}"
        if path.is_file():
            try:
                cap = load_custom_cap(path)
                if cap.name == cap_name:
                    return cap
            except Exception as e:
                logger.error(f"Failed to load custom cap '{cap_name}': {e}")
                return None

    return None


def validate_custom_cap_yaml(content: str) -> CustomCap:
    """Parse and validate custom cap YAML content (for UI preview/validation).

    Returns the CustomCap object or raises ValueError.
    """
    import yaml
    import tempfile

    raw = yaml.safe_load(content)
    if not isinstance(raw, dict):
        raise ValueError("YAML content must be a mapping")

    # Write to temp file to reuse load_custom_cap validation
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        f.write(content)
        tmp_path = Path(f.name)

    try:
        return load_custom_cap(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)


def save_custom_cap_yaml(cap_dict: Dict[str, Any]) -> Path:
    """Save a custom cap definition dict as YAML to the caps directory.

    Returns the path to the saved file.
    Raises ValueError if the definition is invalid.
    """
    import yaml

    name = cap_dict.get("name")
    if not name or not _SAFE_NAME_RE.match(str(name)):
        raise ValueError("Custom cap 'name' is required and must match [A-Za-z0-9._-]")

    caps_dir = _find_custom_caps_dir()
    caps_dir.mkdir(parents=True, exist_ok=True)

    path = caps_dir / f"{name}.yaml"

    # Validate before writing by loading from dict
    content = yaml.dump(cap_dict, default_flow_style=False, sort_keys=False)

    # Round-trip validation
    validate_custom_cap_yaml(content)

    path.write_text(content, encoding="utf-8")
    return path


def delete_custom_cap(name: str) -> bool:
    """Delete a custom cap YAML file. Returns True if file was found and deleted."""
    if not _SAFE_NAME_RE.match(name):
        return False

    caps_dir = _find_custom_caps_dir()
    for suffix in (".yaml", ".yml"):
        path = caps_dir / f"{name}{suffix}"
        # Prevent path traversal
        if not str(path.resolve()).startswith(str(caps_dir.resolve())):
            return False
        if path.is_file():
            path.unlink()
            return True

    return False
