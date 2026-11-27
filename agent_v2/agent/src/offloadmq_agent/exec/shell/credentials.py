"""Credential passthrough for shell jobs.

Each payload ``credentials`` entry::

    {"name": "...", "type": "...", "as": "env" | "file", "mask": true, ...}

Inline types (values come from the client):
    value           {"value": "..."}                         → NAME
    map             {"values": {"K": "V", ...}}              → each K
    login_password  {"login": "...", "password": "...",
                     "login_var"?: ..., "password_var"?: ...} → NAME_LOGIN, NAME_PASSWORD

Agent-host types (resolved on the agent):
    agent_env       {"from"?: "VAR"}                          → NAME
    agent_file      {"path": "~/..."}                         → NAME
    agent_cmd       {"command": "...", "timeout_secs"?: 30}   → NAME (stdout)

``as: "file"`` writes the value to a 0600 file in a scratch dir outside the
workspace and sets the variable to that file's path. Errors name the credential
but never include its value.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .masking import Masker
from .shells import ShellSpec, build_argv
from .subst import env_get, is_env_name

CREDENTIAL_TYPES = ("value", "map", "login_password", "agent_env", "agent_file", "agent_cmd")
_MAX_FILE_BYTES = 1024 * 1024
_DEFAULT_CMD_TIMEOUT = 30
_MAX_CMD_TIMEOUT = 300


class CredentialError(ValueError):
    pass


@dataclass
class ResolvedCredentials:
    env: dict[str, str] = field(default_factory=dict)
    count: int = 0


def validate_credentials(specs: Any) -> list[dict[str, Any]]:
    """Shape check done before anything is downloaded or executed."""
    if specs is None:
        return []
    if not isinstance(specs, list):
        raise CredentialError("'credentials' must be a list")
    out: list[dict[str, Any]] = []
    for i, spec in enumerate(specs):
        if not isinstance(spec, dict):
            raise CredentialError(f"credentials[{i}] must be an object")
        name = spec.get("name")
        if not isinstance(name, str) or not name.strip():
            raise CredentialError(f"credentials[{i}]: 'name' is required")
        kind = spec.get("type")
        if kind not in CREDENTIAL_TYPES:
            raise CredentialError(
                f"credential {name!r}: 'type' must be one of {', '.join(CREDENTIAL_TYPES)}"
            )
        if spec.get("as", "env") not in ("env", "file"):
            raise CredentialError(f"credential {name!r}: 'as' must be 'env' or 'file'")
        # map names are labels; login_password vars are validated when built.
        if kind not in ("map", "login_password") and not is_env_name(name):
            raise CredentialError(f"credential {name!r}: name must be a valid variable name")
        out.append(spec)
    return out


def _require_str(spec: dict[str, Any], key: str) -> str:
    value = spec.get(key)
    if not isinstance(value, str):
        raise CredentialError(f"credential {spec['name']!r}: '{key}' must be a string")
    return value


def _var(spec: dict[str, Any], key: str, default: str) -> str:
    var = spec.get(key) or default
    if not isinstance(var, str) or not is_env_name(var):
        raise CredentialError(f"credential {spec['name']!r}: invalid variable name {var!r}")
    return var


def _run_cmd(
    spec: dict[str, Any], shell: ShellSpec, env: Mapping[str, str], cwd: Path,
    scratch_dir: Path, masker: Masker,
) -> str:
    name = spec["name"]
    command = _require_str(spec, "command")
    try:
        timeout = int(spec.get("timeout_secs") or _DEFAULT_CMD_TIMEOUT)
    except (TypeError, ValueError):
        raise CredentialError(f"credential {name!r}: 'timeout_secs' must be an integer") from None
    timeout = max(1, min(timeout, _MAX_CMD_TIMEOUT))
    argv = build_argv(shell, command, scratch_dir, stem=f"cred-{name}")
    try:
        proc = subprocess.run(
            argv, cwd=cwd, env=dict(env), capture_output=True, timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        raise CredentialError(f"credential {name!r}: command timed out after {timeout}s") from None
    except OSError as exc:
        raise CredentialError(f"credential {name!r}: cannot run command: {exc}") from None
    stdout = proc.stdout.decode("utf-8", errors="replace").rstrip("\r\n")
    if proc.returncode != 0:
        masker.add(stdout)
        stderr = masker(proc.stderr.decode("utf-8", errors="replace").strip())[-500:]
        raise CredentialError(
            f"credential {name!r}: command exited with {proc.returncode}"
            + (f": {stderr}" if stderr else "")
        )
    if not stdout:
        raise CredentialError(f"credential {name!r}: command printed nothing")
    return stdout


def _read_file(spec: dict[str, Any]) -> bytes:
    name = spec["name"]
    path = Path(_require_str(spec, "path")).expanduser()
    try:
        if path.stat().st_size > _MAX_FILE_BYTES:
            raise CredentialError(f"credential {name!r}: {path} is larger than 1 MiB")
        return path.read_bytes()
    except OSError as exc:
        raise CredentialError(f"credential {name!r}: cannot read {path}: {exc.strerror}") from None


def _write_secret_file(scratch_dir: Path, var: str, data: bytes) -> str:
    target = scratch_dir / f"cred-{var}"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return str(target)


def resolve_credentials(
    specs: list[dict[str, Any]],
    *,
    shell: ShellSpec,
    env: Mapping[str, str],
    cwd: Path,
    scratch_dir: Path,
    masker: Masker,
    agent_env: Mapping[str, str] | None = None,
) -> ResolvedCredentials:
    """Resolve every credential into variables; every value is registered with ``masker``."""
    agent_env = os.environ if agent_env is None else agent_env
    result = ResolvedCredentials()

    for spec in specs:
        name: str = spec["name"]
        kind = spec["type"]
        mask = spec.get("mask", True) is not False
        as_file = spec.get("as", "env") == "file"
        pairs: list[tuple[str, str | bytes]] = []

        if kind == "value":
            pairs.append((name, _require_str(spec, "value")))
        elif kind == "map":
            values = spec.get("values")
            if not isinstance(values, dict) or not values:
                raise CredentialError(f"credential {name!r}: 'values' must be a non-empty object")
            for key, val in values.items():
                if not isinstance(key, str) or not is_env_name(key):
                    raise CredentialError(f"credential {name!r}: invalid variable name {key!r}")
                if not isinstance(val, str):
                    raise CredentialError(f"credential {name!r}: value of {key!r} must be a string")
                pairs.append((key, val))
        elif kind == "login_password":
            pairs.append((_var(spec, "login_var", f"{name}_LOGIN"), _require_str(spec, "login")))
            pairs.append(
                (_var(spec, "password_var", f"{name}_PASSWORD"), _require_str(spec, "password"))
            )
        elif kind == "agent_env":
            source = spec.get("from") or name
            if not isinstance(source, str):
                raise CredentialError(f"credential {name!r}: 'from' must be a string")
            value = env_get(agent_env, source)
            if value is None:
                raise CredentialError(
                    f"credential {name!r}: agent environment variable {source!r} is not set"
                )
            pairs.append((name, value))
        elif kind == "agent_file":
            data = _read_file(spec)
            pairs.append((name, data if as_file else _decode_file(name, data)))
        elif kind == "agent_cmd":
            pairs.append((name, _run_cmd(spec, shell, env, cwd, scratch_dir, masker)))

        for var, secret in pairs:
            if var in result.env:
                raise CredentialError(f"credential {name!r}: variable {var} is set twice")
            text = secret.decode("utf-8", errors="ignore") if isinstance(secret, bytes) else secret
            if mask:
                masker.add(text)
            if as_file:
                raw = secret if isinstance(secret, bytes) else secret.encode("utf-8")
                result.env[var] = _write_secret_file(scratch_dir, var, raw)
            else:
                if "\x00" in text:
                    raise CredentialError(f"credential {name!r}: value contains a NUL byte")
                result.env[var] = text
        result.count += 1
    return result


def _decode_file(name: str, data: bytes) -> str:
    try:
        return data.decode("utf-8").rstrip("\r\n")
    except UnicodeDecodeError:
        raise CredentialError(
            f"credential {name!r}: file is not UTF-8 text — use \"as\": \"file\" for binary files"
        ) from None
