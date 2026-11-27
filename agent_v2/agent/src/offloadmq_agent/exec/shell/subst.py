"""``${…}`` substitution and env-map evaluation for shell jobs.

Grammar (same for ``env`` values and ``workspace``):

    ${rand}              12 hex chars, one random value per task
    ${rand:N}            first N (1-32) chars of the same per-task value
    ${task_id}           the task id
    ${date} / ${ts}      UTC YYYYMMDD / unix seconds (fixed at task start)
    ${home} / ${tmp}     agent user's home / system temp dir
    ${env:NAME}          variable from the env being built (error if unset)
    ${env:NAME:-dflt}    … or ``dflt`` when unset or empty
    ${NAME}              shorthand for ${env:NAME}
    $${                  literal "${"
"""
from __future__ import annotations

import os
import re
import secrets
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

_TOKEN = re.compile(r"\$\$\{|\$\{([^{}]*)\}")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_RAND_LEN = 32

# Kept when ``inherit_env`` is false: the minimum a shell needs to start.
_MINIMAL_ENV_KEYS = (
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR",
    "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT",
    "TEMP", "TMP", "USERPROFILE",
)


class SubstitutionError(ValueError):
    """A ``${…}`` token could not be resolved."""


def is_env_name(name: str) -> bool:
    return bool(_ENV_NAME.match(name))


@dataclass
class SubstContext:
    task_id: str
    rand: str = field(default_factory=lambda: secrets.token_hex(_RAND_LEN // 2))
    started: float = field(default_factory=time.time)

    def builtin(self, name: str) -> str | None:
        if name == "rand":
            return self.rand[:12]
        if name.startswith("rand:"):
            try:
                n = int(name[5:])
            except ValueError:
                raise SubstitutionError(f"${{{name}}}: length must be an integer") from None
            if not 1 <= n <= _RAND_LEN:
                raise SubstitutionError(f"${{{name}}}: length must be 1-{_RAND_LEN}")
            return self.rand[:n]
        if name == "task_id":
            return self.task_id
        if name == "date":
            return time.strftime("%Y%m%d", time.gmtime(self.started))
        if name == "ts":
            return str(int(self.started))
        if name == "home":
            return str(Path.home())
        if name == "tmp":
            return tempfile.gettempdir()
        return None


def env_get(env: Mapping[str, str], name: str) -> str | None:
    if name in env:
        return env[name]
    if sys.platform == "win32":  # Windows env names are case-insensitive
        upper = name.upper()
        for key, value in env.items():
            if key.upper() == upper:
                return value
    return None


def env_set(env: dict[str, str], name: str, value: str | None) -> None:
    if sys.platform == "win32":
        upper = name.upper()
        for key in [k for k in env if k.upper() == upper]:
            del env[key]
    else:
        env.pop(name, None)
    if value is not None:
        env[name] = value


def substitute(text: str, ctx: SubstContext, env: Mapping[str, str]) -> str:
    def replace(match: re.Match[str]) -> str:
        if match.group(0) == "$${":
            return "${"
        expr = match.group(1).strip()
        value = ctx.builtin(expr)
        if value is not None:
            return value
        name = expr[4:] if expr.startswith("env:") else expr
        default: str | None = None
        if ":-" in name:
            name, default = name.split(":-", 1)
        if not is_env_name(name):
            raise SubstitutionError(f"Unknown variable ${{{expr}}}")
        current = env_get(env, name)
        if default is not None and not current:
            return default
        if current is None:
            raise SubstitutionError(
                f"${{{expr}}}: environment variable {name!r} is not set "
                f"(use ${{env:{name}:-default}} for a fallback)"
            )
        return current

    return _TOKEN.sub(replace, text)


def build_env(
    payload_env: Any,
    inherit: bool,
    ctx: SubstContext,
    base: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Agent env (or a minimal subset) + the payload ``env`` map, applied in order.

    A ``null`` value removes the variable. Values may reference variables set by
    earlier keys.
    """
    source = dict(os.environ if base is None else base)
    if inherit:
        env = source
    else:
        env = {k: v for k, v in source.items() if k in _MINIMAL_ENV_KEYS}

    if payload_env is None:
        return env
    if not isinstance(payload_env, dict):
        raise SubstitutionError("'env' must be an object of NAME: value")
    for name, raw in payload_env.items():
        if not isinstance(name, str) or not is_env_name(name):
            raise SubstitutionError(f"Invalid environment variable name {name!r}")
        if raw is None:
            env_set(env, name, None)
            continue
        if isinstance(raw, bool):
            raw = "true" if raw else "false"
        elif isinstance(raw, (int, float)):
            raw = str(raw)
        elif not isinstance(raw, str):
            raise SubstitutionError(f"env {name!r}: value must be a string")
        env_set(env, name, substitute(raw, ctx, env))
    return env
