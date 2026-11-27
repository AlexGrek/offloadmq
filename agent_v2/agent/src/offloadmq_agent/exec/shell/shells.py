"""Shell interpreters behind the ``shell.*`` capability family.

One table, shared by the capability probe and the executor, so what the agent
advertises is exactly what it can run:

    shell.bash   bash (Git for Windows bash on Windows — never the WSL stub)
    shell.zsh    zsh
    shell.posix  /bin/sh (macOS + Linux)
    shell.pwsh   PowerShell 7
    shell.cmd    cmd.exe (Windows)
    shell.any    the agent's default shell (see ``_ANY_ORDER``)
"""
from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

# Capability suffixes, in the order they are advertised.
SHELL_CAPS = ("bash", "zsh", "posix", "pwsh", "cmd", "any")

# Default interpreter for shell.any, by platform family.
_ANY_ORDER_UNIX = ("bash", "zsh", "posix")
_ANY_ORDER_WINDOWS = ("pwsh", "powershell", "cmd", "bash")

_POSIX_FAMILY = frozenset({"bash", "zsh", "posix"})
_POWERSHELL_FAMILY = frozenset({"pwsh", "powershell"})


@dataclass(frozen=True)
class ShellSpec:
    """One runnable interpreter.

    ``kind`` is the interpreter family member (bash, zsh, posix, pwsh,
    powershell, cmd); ``path`` is the executable.
    """

    kind: str
    path: str

    @property
    def script_ext(self) -> str:
        if self.kind in _POWERSHELL_FAMILY:
            return ".ps1"
        if self.kind == "cmd":
            return ".cmd"
        return ".sh"

    @property
    def prefers_script(self) -> bool:
        # cmd.exe's own command-line parsing mangles quotes in `/c "<cmd>"`;
        # a script file sidesteps it entirely.
        return self.kind == "cmd"

    def strict_prelude(self) -> str:
        if self.kind in ("bash", "zsh"):
            return "set -euo pipefail\n"
        if self.kind == "posix":
            return "set -eu\n"
        if self.kind in _POWERSHELL_FAMILY:
            return "$ErrorActionPreference = 'Stop'\n"
        return ""  # cmd has no equivalent

    def command_argv(self, command: str) -> list[str]:
        if self.kind in _POSIX_FAMILY:
            return [self.path, "-c", command]
        if self.kind in _POWERSHELL_FAMILY:
            return [self.path, "-NoProfile", "-NonInteractive", "-Command", command]
        return [self.path, "/d", "/s", "/c", command]

    def script_argv(self, script: Path) -> list[str]:
        if self.kind in _POSIX_FAMILY:
            return [self.path, str(script)]
        if self.kind in _POWERSHELL_FAMILY:
            argv = [self.path, "-NoProfile", "-NonInteractive"]
            if sys.platform == "win32":
                argv += ["-ExecutionPolicy", "Bypass"]
            return argv + ["-File", str(script)]
        return [self.path, "/d", "/c", str(script)]

    def script_text(self, body: str) -> str:
        if self.kind == "cmd":
            return "@echo off\r\n" + body.replace("\r\n", "\n").replace("\n", "\r\n")
        return body

    @property
    def script_encoding(self) -> str:
        # Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
        return "utf-8-sig" if self.kind in _POWERSHELL_FAMILY else "utf-8"


Which = Callable[[str], "str | None"]
Exists = Callable[[str], bool]


def _is_wsl_stub(path: str) -> bool:
    """True for System32\\bash.exe / the WindowsApps alias — both launch WSL, not Git Bash."""
    lowered = os.path.normcase(os.path.abspath(path))
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or r"C:\Windows"
    system32 = os.path.normcase(os.path.join(system_root, "System32"))
    return lowered.startswith(system32 + os.sep) or "windowsapps" in lowered


def _git_bash_candidates(which: Which) -> list[str]:
    candidates: list[str] = []
    on_path = which("bash")
    if on_path and not _is_wsl_stub(on_path):
        candidates.append(on_path)
    git = which("git")
    if git:
        # <Git>\cmd\git.exe or <Git>\bin\git.exe → <Git>\bin\bash.exe
        root = Path(git).resolve().parent.parent
        candidates += [str(root / "bin" / "bash.exe"), str(root / "usr" / "bin" / "bash.exe")]
    for var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        base = os.environ.get(var)
        if base:
            candidates.append(os.path.join(base, "Git", "bin", "bash.exe"))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(os.path.join(local, "Programs", "Git", "bin", "bash.exe"))
    return candidates


def detect_shells(
    platform: str | None = None,
    which: Which = shutil.which,
    exists: Exists = os.path.exists,
) -> dict[str, ShellSpec]:
    """Map capability suffix (``bash``, ``zsh``, …, ``any``) → interpreter.

    Only suffixes that can actually run are present.
    """
    platform = platform or sys.platform
    found: dict[str, ShellSpec] = {}
    order: tuple[str, ...]

    if platform == "win32":
        bash = next((c for c in _git_bash_candidates(which) if exists(c)), None)
        if bash:
            found["bash"] = ShellSpec("bash", bash)
        pwsh = which("pwsh")
        if pwsh:
            found["pwsh"] = ShellSpec("pwsh", pwsh)
        cmd = os.environ.get("ComSpec") or which("cmd")
        if cmd and exists(cmd):
            found["cmd"] = ShellSpec("cmd", cmd)
        powershell = which("powershell")
        defaults = {**found}
        if powershell:
            defaults["powershell"] = ShellSpec("powershell", powershell)
        order = _ANY_ORDER_WINDOWS
    else:
        bash = which("bash")
        if bash:
            found["bash"] = ShellSpec("bash", bash)
        zsh = which("zsh")
        if zsh:
            found["zsh"] = ShellSpec("zsh", zsh)
        sh = "/bin/sh" if exists("/bin/sh") else which("sh")
        if sh:
            found["posix"] = ShellSpec("posix", sh)
        pwsh = which("pwsh")
        if pwsh:
            found["pwsh"] = ShellSpec("pwsh", pwsh)
        defaults = {**found}
        order = _ANY_ORDER_UNIX

    default = next((defaults[k] for k in order if k in defaults), None)
    if default is not None:
        found["any"] = default
    return found


def build_argv(
    spec: ShellSpec, command: str, scratch_dir: Path, *, strict: bool = False, stem: str = "job",
) -> list[str]:
    """argv running ``command`` under ``spec``.

    Multi-line commands (and everything for cmd.exe) are written to a script in
    ``scratch_dir`` — kept outside the workspace so it never becomes an artifact.
    """
    body = (spec.strict_prelude() if strict else "") + command
    if not spec.prefers_script and "\n" not in body.strip():
        return spec.command_argv(body)
    script = scratch_dir / f"{stem}{spec.script_ext}"
    if not body.endswith("\n"):
        body += "\n"
    script.write_text(spec.script_text(body), encoding=spec.script_encoding, newline="")
    return spec.script_argv(script)


def shell_capabilities(shells: dict[str, ShellSpec]) -> list[str]:
    return [f"shell.{name}" for name in SHELL_CAPS if name in shells]
