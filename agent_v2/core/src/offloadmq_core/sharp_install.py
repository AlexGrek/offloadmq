"""Install / remove the Apple SHARP runtime behind ``world.sharp``.

Nothing is installed with the agent. ``omq sharp install`` and the GUI's World
(SHARP) page call :func:`install`, which builds the private venv described in
``offloadmq_agent.exec.world.sharp_runtime`` from the vendored
``third_party/ml-sharp`` submodule (or the copy bundled into a frozen build):
``uv venv`` → a torch build from the PyTorch index (CUDA 12.8 when an NVIDIA
driver is present) pinned like upstream → the package itself, constrained by
upstream's ``requirements.txt`` → the 2.8 GB checkpoint into the models dir.

Idempotent: re-running only does what is missing, so it doubles as a repair.
Requires ``uv`` on PATH (it also fetches a matching CPython).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from offloadmq_agent.exec.world import sharp_runtime as rt
from offloadmq_agent.exec.world.sharp_runtime import SharpPaths

from offloadmq_core.install_job import InstallJob, LogFn

PYTHON_VERSION = "3.13"  # upstream's .python-version
CUDA_INDEX = "https://download.pytorch.org/whl/cu128"  # cu128: first build with Blackwell (RTX 50xx)
CPU_INDEX = "https://download.pytorch.org/whl/cpu"
TORCH_INDEX_CHOICES = ("auto", "cuda", "cpu", "pypi")
# Installed from the torch index, so excluded from the PyPI constraints file.
_TORCH_STACK = re.compile(r"^(torch|torchvision|triton|nvidia-[\w-]+)$", re.I)
_PIN = re.compile(r"^([A-Za-z0-9_.\-\[\]]+)==")
_COPY_IGNORE = shutil.ignore_patterns(".git", "__pycache__", "data", "*.egg-info", "build")


class SharpInstallError(RuntimeError):
    pass


def resolve_torch_index(choice: str | None) -> str | None:
    """``auto``/``cuda``/``cpu``/``pypi`` or a URL → index URL (``None`` = PyPI)."""
    c = (choice or "auto").strip()
    if c == "auto":
        if sys.platform == "darwin":
            return None  # PyPI wheels carry MPS
        return CUDA_INDEX if shutil.which("nvidia-smi") else CPU_INDEX
    if c == "cuda":
        return CUDA_INDEX
    if c == "cpu":
        return CPU_INDEX
    if c == "pypi":
        return None
    if c.startswith(("http://", "https://")):
        return c
    raise SharpInstallError(f"torch index must be one of {', '.join(TORCH_INDEX_CHOICES)} or a URL, got {c!r}")


def _clean_env() -> dict[str, str]:
    # Never let the agent's own venv / uv project leak into the SHARP venv.
    env = {k: v for k, v in os.environ.items() if not k.startswith(("UV_", "PYTHON")) and k != "VIRTUAL_ENV"}
    env["PYTHONUTF8"] = "1"
    return env


def _run(cmd: list[str], log: LogFn) -> str:
    log("$ " + " ".join(cmd))
    proc = subprocess.run(
        cmd, env=_clean_env(), capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or proc.stdout).strip().splitlines()[-25:])
        raise SharpInstallError(f"command failed ({proc.returncode}): {' '.join(cmd)}\n{tail}")
    return proc.stdout


def source_digest(src: Path) -> str:
    """Content hash of what gets installed — works without git (frozen builds)."""
    h = hashlib.sha256()
    files = [src / "pyproject.toml", src / "requirements.txt", *sorted((src / "src").rglob("*.py"))]
    for f in files:
        if f.is_file():
            h.update(f.relative_to(src).as_posix().encode())
            h.update(f.read_bytes())
    return h.hexdigest()


def git_revision(src: Path) -> str:
    git = shutil.which("git")
    if not git or not (src / ".git").exists():
        return ""
    try:
        out = subprocess.run([git, "-C", str(src), "rev-parse", "HEAD"], capture_output=True, text=True,
                             timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def parse_requirements(text: str) -> tuple[dict[str, str], list[str]]:
    """Split upstream's uv-compiled requirements into torch pins and PyPI constraints."""
    torch_pins: dict[str, str] = {}
    constraints: list[str] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        m = _PIN.match(line)
        if not m:
            continue  # "-e .", comments, continuation lines
        name = m.group(1).split("[", 1)[0]
        if _TORCH_STACK.match(name):
            if name.lower() in ("torch", "torchvision"):
                torch_pins[name.lower()] = line.split(";", 1)[0].strip()
            continue
        constraints.append(line)
    return torch_pins, constraints


def _download(url: str, dest: Path, log: LogFn, cancelled: Callable[[], bool]) -> None:
    import requests

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    log(f"Downloading {url} -> {dest}")
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        done, next_pct, started = 0, 10, time.monotonic()
        with part.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if cancelled():
                    raise SharpInstallError("cancelled")
                f.write(chunk)
                done += len(chunk)
                if total and done * 100 >= next_pct * total:
                    log(f"  {next_pct}% of {total / 2**20:.0f} MiB ({time.monotonic() - started:.0f}s)")
                    next_pct += 10
    if part.stat().st_size != (total or rt.CHECKPOINT_BYTES):
        raise SharpInstallError(f"model download truncated: {part.stat().st_size} of {total} bytes")
    os.replace(part, dest)


def install(
    paths: SharpPaths,
    log: LogFn = print,
    torch_index: str | None = "auto",
    force: bool = False,
    cancelled: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """Install or repair the SHARP runtime at ``paths``; returns the written manifest.

    ``force`` rebuilds the venv from scratch. The model is only downloaded when
    it is missing or not exactly :data:`~sharp_runtime.CHECKPOINT_BYTES` long.
    """
    src = rt.find_source()
    if src is None:
        raise SharpInstallError(
            "ml-sharp source not found: in a checkout run "
            "`git submodule update --init agent_v2/third_party/ml-sharp`"
        )
    uv = shutil.which("uv")
    if not uv:
        raise SharpInstallError("uv is required to build the SHARP venv: https://docs.astral.sh/uv/")
    index = resolve_torch_index(torch_index)
    digest = source_digest(src)
    revision = git_revision(src)
    old = rt.status(paths)
    log(f"SHARP source {src} ({revision[:12] or 'no git'}, digest {digest[:12]})")
    log(f"venv: {paths.venv}")
    log(f"models: {paths.models}")

    def step() -> None:
        if cancelled():
            raise SharpInstallError("cancelled")

    if force and paths.venv.exists():
        log("force: removing existing venv")
        shutil.rmtree(paths.venv)
    if not paths.python.is_file():
        if paths.venv.exists() and any(paths.venv.iterdir()):
            raise SharpInstallError(f"{paths.venv} exists and is not a venv; choose an empty or new directory")
        _run([uv, "venv", str(paths.venv), "--python", PYTHON_VERSION], log)
    step()

    dst = paths.source_copy
    if force or old.manifest.get("source_digest") != digest or not (dst / "pyproject.toml").is_file():
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst, ignore=_COPY_IGNORE)

    torch_pins, constraints = parse_requirements((dst / "requirements.txt").read_text(encoding="utf-8"))
    pins = [torch_pins.get("torch", "torch"), torch_pins.get("torchvision", "torchvision")]
    log(f"torch from {index or 'PyPI'} (several GB on first install)")
    _run([uv, "pip", "install", "--python", str(paths.python), *pins, *(["--index-url", index] if index else [])], log)
    step()

    constraints_file = paths.venv / "omq-constraints.txt"
    constraints_file.write_text("\n".join(constraints) + "\n", encoding="utf-8")
    # Non-editable: the venv must not depend on a checkout or a PyInstaller temp dir.
    _run([uv, "pip", "install", "--python", str(paths.python), str(dst), "-c", str(constraints_file),
          "--reinstall-package", "sharp"], log)
    step()

    if old.has_checkpoint:
        log(f"Model present: {paths.checkpoint} ({old.checkpoint_bytes / 2**20:.0f} MiB)")
    else:
        if paths.checkpoint.exists():
            log(f"Model at {paths.checkpoint} is {old.checkpoint_bytes} bytes, expected "
                f"{rt.CHECKPOINT_BYTES}; downloading again")
        _download(rt.CHECKPOINT_URL, paths.checkpoint, log, cancelled)

    log("Checking that torch and sharp import inside the venv")
    info = _probe_runtime(paths)
    if not paths.cli.is_file():
        raise SharpInstallError(f"`sharp` console script missing at {paths.cli}")

    manifest: dict[str, Any] = {
        "revision": revision or old.manifest.get("revision") or "",
        "source_digest": digest,
        "torch": info.get("torch"),
        "cuda": bool(info.get("cuda")),
        "device": info.get("device"),
        "torch_index": index or "pypi",
        "installed_at": int(time.time()),
    }
    paths.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log(f"SHARP ready: torch {manifest['torch']}, "
        f"{'CUDA ' + str(manifest['device']) if manifest['cuda'] else 'no CUDA (CPU, very slow)'}")
    return manifest


def uninstall(paths: SharpPaths, remove_models: bool = True, log: LogFn = print) -> None:
    """Delete the venv (and optionally the model). Directories you pointed at stay."""
    if paths.venv.exists():
        if not paths.python.is_file() and not paths.manifest.is_file():
            raise SharpInstallError(f"{paths.venv} does not look like a SHARP venv; not deleting it")
        log(f"Removing {paths.venv}")
        shutil.rmtree(paths.venv)
    if remove_models:
        for f in (paths.checkpoint, paths.checkpoint.with_suffix(paths.checkpoint.suffix + ".part")):
            if f.exists():
                log(f"Removing {f}")
                f.unlink()


# --------------------------------------------------------------------------- doctor


def _probe_runtime(paths: SharpPaths) -> dict[str, Any]:
    """Import torch + sharp inside the venv; raises SharpInstallError on failure."""
    cmd = [str(paths.python), "-c", (
        "import json, torch, sharp.cli; "
        "print(json.dumps({'torch': torch.__version__, 'cuda': torch.cuda.is_available(), "
        "'device': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"
    )]
    try:
        proc = subprocess.run(cmd, env=_clean_env(), capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=180,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError) as e:
        raise SharpInstallError(f"cannot run {paths.python}: {e}") from e
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or ["no output"]
        raise SharpInstallError(f"import torch/sharp failed: {tail[0]}")
    info: dict[str, Any] = json.loads(proc.stdout.strip().splitlines()[-1])
    return info


def doctor(paths: SharpPaths, torch_index: str | None = "auto") -> dict[str, Any]:
    """Check every piece of the runtime. Never modifies anything.

    Returns ``{ok, checks: [{name, ok, detail}], action}`` where ``action`` is what
    :func:`repair` would do: ``None``, ``"install"`` (fill in / update) or
    ``"reinstall"`` (rebuild the venv from scratch).
    """
    checks: list[dict[str, Any]] = []
    rebuild = update = False

    def check(name: str, ok: bool, detail: str) -> bool:
        checks.append({"name": name, "ok": ok, "detail": detail})
        return ok

    src = rt.find_source()
    check("source", src is not None,
          str(src) if src else "ml-sharp source missing from this build (git submodule not checked out)")
    uv = shutil.which("uv")
    check("uv", uv is not None, uv or "uv not on PATH: https://docs.astral.sh/uv/")
    st = rt.status(paths)

    if check("venv", paths.python.is_file(), str(paths.python) if paths.python.is_file()
             else f"no python at {paths.python}"):
        if not check("sharp command", paths.cli.is_file(), str(paths.cli)):
            update = True
        try:
            info = _probe_runtime(paths)
            want_cuda = resolve_torch_index(torch_index) == CUDA_INDEX
            cuda_ok = bool(info.get("cuda")) or not want_cuda
            detail = f"torch {info.get('torch')}, " + (
                f"CUDA on {info.get('device')}" if info.get("cuda") else "CPU only")
            if not check("torch", cuda_ok, detail + ("" if cuda_ok else " but a CUDA build was requested")):
                rebuild = True
        except SharpInstallError as e:
            check("torch", False, str(e))
            rebuild = True
    else:
        update = True

    if check("model", st.has_checkpoint,
             f"{paths.checkpoint} ({st.checkpoint_bytes / 2**20:.0f} MiB)" if st.has_checkpoint
             else f"{paths.checkpoint}: {st.checkpoint_bytes} of {rt.CHECKPOINT_BYTES} bytes"):
        pass
    else:
        update = True

    if src is not None and paths.python.is_file():
        current = st.manifest.get("source_digest") == source_digest(src)
        if not check("up to date", current, "installed source matches this agent's ml-sharp" if current
                     else "installed SHARP differs from the version bundled with this agent"):
            update = True

    action = "reinstall" if rebuild else "install" if update else None
    return {"ok": all(c["ok"] for c in checks), "checks": checks, "action": action}


def repair(paths: SharpPaths, log: LogFn = print, torch_index: str | None = "auto",
           cancelled: Callable[[], bool] = lambda: False) -> dict[str, Any]:
    """Run :func:`doctor`, then fix whatever it found (no-op when healthy)."""
    report = doctor(paths, torch_index)
    for c in report["checks"]:
        log(f"[{'ok' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
    if report["action"] is None:
        log("Nothing to repair.")
        return report
    log(f"Repair: {report['action']}")
    install(paths, log, torch_index, force=report["action"] == "reinstall", cancelled=cancelled)
    return doctor(paths, torch_index)


class SharpInstallJob(InstallJob):
    """One install/uninstall at a time, on a daemon thread, with a log tail for the GUI."""

    def __init__(self) -> None:
        super().__init__("SHARP", SharpInstallError)
