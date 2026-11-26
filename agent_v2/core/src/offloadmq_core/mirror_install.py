"""Install / verify / remove the WorldMirror 2.0 runtime behind ``world.mirror``.

Nothing is installed with the agent, and nothing of Tencent's is bundled.
:func:`install` requires the licence to be accepted, then builds what
``offloadmq_agent.exec.world.mirror_runtime`` describes: a ``uv`` venv with CUDA
torch, a sparse ``git`` checkout of HY-World-2.0 at a pinned commit, and the
sha256-verified weights (4.7 GiB) and sky model (168 MiB).

Idempotent: verified pieces are kept, so it doubles as a repair — and it adopts a
directory laid out the same way (``examples/vr-world-poc`` builds one).
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import requests

from offloadmq_agent.exec.world import mirror_runtime as rt
from offloadmq_agent.exec.world.mirror_runner import SHIM_SOURCE
from offloadmq_agent.exec.world.mirror_runtime import MirrorPaths, ModelFile

from offloadmq_core.install_job import InstallJob, LogFn

PYTHON_VERSION = "3.11"
CUDA_INDEX = "https://download.pytorch.org/whl/cu128"  # cu128: first build with Blackwell (RTX 50xx)
TORCH_PINS = ("torch==2.7.1", "torchvision==0.22.1")
#: What the official pipeline imports; the pinned ones are what A1 was verified with.
PACKAGES = (
    "numpy==1.26.4", "einops==0.8.2", "safetensors==0.8.0", "omegaconf", "opencv-python-headless==4.10.0.84",
    "pillow", "plyfile==1.1.3", "onnxruntime", "huggingface_hub", "scipy", "gsplat==1.5.3", "trimesh",
    "requests", "matplotlib", "tqdm",
)

NotCancelled: Callable[[], bool] = lambda: False


class MirrorInstallError(RuntimeError):
    pass


class MirrorInstallJob(InstallJob):
    def __init__(self) -> None:
        super().__init__("WorldMirror", MirrorInstallError)


def _clean_env(paths: MirrorPaths) -> dict[str, str]:
    # Never let the agent's own venv / uv project leak into this one, and keep uv's
    # multi-GB download cache on the drive the operator chose.
    env = {k: v for k, v in os.environ.items() if not k.startswith(("UV_", "PYTHON")) and k != "VIRTUAL_ENV"}
    env["PYTHONUTF8"] = "1"
    env["UV_CACHE_DIR"] = str(paths.root / "uv-cache")
    return env


def _run(cmd: list[str], paths: MirrorPaths, log: LogFn, timeout: float | None = None) -> str:
    log("$ " + " ".join(cmd))
    try:
        proc = subprocess.run(
            cmd, env=_clean_env(paths), capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise MirrorInstallError(f"cannot run {cmd[0]}: {e}") from e
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or proc.stdout).strip().splitlines()[-25:])
        raise MirrorInstallError(f"command failed ({proc.returncode}): {' '.join(cmd)}\n{tail}")
    return proc.stdout


# --------------------------------------------------------------------------- pieces


def _remove_file(path: Path) -> None:
    """``unlink(missing_ok=True)`` that rides out a concurrent reader: on Windows a status
    poll holding the file open makes the delete fail for a moment."""
    for attempt in range(40):
        try:
            path.unlink(missing_ok=True)
            return
        except PermissionError:
            if attempt == 39:
                raise
            time.sleep(0.05)


def code_digest(source: Path) -> str:
    """Content hash of ``hyworld2/**/*.py``, independent of line-ending conversion."""
    root = source / "hyworld2"
    h = hashlib.sha256()
    for f in sorted(root.rglob("*.py"), key=lambda p: p.relative_to(root).as_posix()):
        h.update(f.relative_to(root).as_posix().encode())
        h.update(f.read_bytes().replace(b"\r\n", b"\n"))
    return h.hexdigest()


def code_ok(paths: MirrorPaths) -> bool:
    return paths.pipeline.is_file() and code_digest(paths.source) == rt.CODE_DIGEST


def verify_file(path: Path, spec: ModelFile, cancelled: Callable[[], bool] = NotCancelled) -> tuple[bool, str]:
    if not path.is_file():
        return False, f"{path} missing"
    size = path.stat().st_size
    if size != spec.bytes:
        return False, f"{path}: {size} bytes, expected {spec.bytes}"
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            if cancelled():
                raise MirrorInstallError("cancelled")
            h.update(chunk)
    if h.hexdigest() != spec.sha256:
        return False, f"{path}: sha256 {h.hexdigest()[:12]}…, expected {spec.sha256[:12]}…"
    return True, f"{path} ({size / 2**20:.1f} MiB, sha256 ok)"


def _download(spec: ModelFile, dest: Path, log: LogFn, cancelled: Callable[[], bool]) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    log(f"Downloading {spec.url} -> {dest}")
    h = hashlib.sha256()
    try:
        with requests.get(spec.url, stream=True, timeout=60) as r:
            r.raise_for_status()
            done, next_pct, started = 0, 10, time.monotonic()
            with part.open("wb") as f:
                for chunk in r.iter_content(chunk_size=1 << 20):
                    if cancelled():
                        raise MirrorInstallError("cancelled")
                    f.write(chunk)
                    h.update(chunk)
                    done += len(chunk)
                    if spec.bytes > 1 << 26 and done * 100 >= next_pct * spec.bytes:
                        log(f"  {next_pct}% of {spec.bytes / 2**20:.0f} MiB ({time.monotonic() - started:.0f}s)")
                        next_pct += 10
        if h.hexdigest() != spec.sha256:
            raise MirrorInstallError(f"download checksum mismatch for {dest.name}: sha256 {h.hexdigest()}")
        os.replace(part, dest)
    except requests.RequestException as e:
        raise MirrorInstallError(f"download failed: {e}") from e
    finally:
        part.unlink(missing_ok=True)


def fetch_code(paths: MirrorPaths, log: LogFn) -> None:
    """Sparse checkout of the pinned commit (only the reconstruction package)."""
    if code_ok(paths):
        log(f"Code present: {paths.source} ({rt.CODE_REVISION[:12]})")
        return
    git = shutil.which("git")
    if not git:
        raise MirrorInstallError("git is required to fetch HY-World-2.0: https://git-scm.com/")
    src = paths.source
    if src.exists() and any(src.iterdir()) and not (src / ".git").is_dir():
        raise MirrorInstallError(f"{src} exists and is not a git checkout; move it away")
    src.mkdir(parents=True, exist_ok=True)
    base = [git, "-C", str(src)]
    if not (src / ".git").is_dir():
        _run([*base, "init", "--quiet"], paths, log)
        _run([*base, "remote", "add", "origin", rt.CODE_REPO], paths, log)
    _run([*base, "config", "core.autocrlf", "false"], paths, log)
    _run([*base, "sparse-checkout", "set", rt.CODE_SPARSE], paths, log)
    _run([*base, "fetch", "--depth", "1", "--filter=blob:none", "origin", rt.CODE_REVISION], paths, log, 600)
    _run([*base, "checkout", "--force", "--quiet", rt.CODE_REVISION], paths, log, 600)
    if not code_ok(paths):
        raise MirrorInstallError(f"checkout at {src} does not match the pinned revision's content")


def _probe_runtime(paths: MirrorPaths) -> dict[str, Any]:
    """Import torch and the pipeline inside the venv; raises MirrorInstallError on failure."""
    code = SHIM_SOURCE + (
        "\nimport json\n"
        f"sys.path.insert(0, {str(paths.source)!r})\n"
        "import torch\n"
        "from hyworld2.worldrecon.pipeline import WorldMirrorPipeline\n"
        "print(json.dumps({'torch': torch.__version__, 'cuda': torch.cuda.is_available(), "
        "'device': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))\n"
    )
    out = _run([str(paths.python), "-c", code], paths, lambda _line: None, 600)
    info: dict[str, Any] = json.loads(out.strip().splitlines()[-1])
    return info


# --------------------------------------------------------------------------- install / uninstall


def install(
    paths: MirrorPaths,
    license_accepted: bool,
    log: LogFn = print,
    force: bool = False,
    cancelled: Callable[[], bool] = NotCancelled,
) -> dict[str, Any]:
    """Install or repair the runtime at ``paths``; returns the written manifest.

    ``force`` rebuilds the venv from scratch. Code and model files are fetched only
    when missing or not matching their pinned checksums.
    """
    if not license_accepted:
        raise MirrorInstallError(f"accept the licence first. {rt.LICENSE_NOTICE} {rt.LICENSE_URL}")
    uv = shutil.which("uv")
    if not uv:
        raise MirrorInstallError("uv is required to build the WorldMirror venv: https://docs.astral.sh/uv/")
    log(f"Licence: {rt.LICENSE_NOTICE}")
    log(f"directory: {paths.root}")
    paths.root.mkdir(parents=True, exist_ok=True)
    _remove_file(paths.manifest)  # nothing is advertised until the checks pass again

    def step() -> None:
        if cancelled():
            raise MirrorInstallError("cancelled")

    if force and paths.venv.exists():
        if not paths.python.is_file() and any(paths.venv.iterdir()):
            raise MirrorInstallError(f"{paths.venv} does not look like a venv; not deleting it")
        log("force: removing existing venv")
        shutil.rmtree(paths.venv)
    if not paths.python.is_file():
        if paths.venv.exists() and any(paths.venv.iterdir()):
            raise MirrorInstallError(f"{paths.venv} exists and is not a venv; choose an empty or new directory")
        _run([uv, "venv", str(paths.venv), "--python", PYTHON_VERSION], paths, log)
    step()
    log("CUDA torch (several GB on first install)")
    _run([uv, "pip", "install", "--python", str(paths.python), *TORCH_PINS, "--index-url", CUDA_INDEX], paths, log)
    step()
    _run([uv, "pip", "install", "--python", str(paths.python), *PACKAGES], paths, log)
    step()
    fetch_code(paths, log)
    step()
    for spec in rt.MODEL_FILES:
        dest = paths.file(spec)
        ok, detail = verify_file(dest, spec, cancelled)
        if ok:
            log(f"Present: {detail}")
            continue
        if dest.exists():
            log(f"{detail}; downloading again")
        _download(spec, dest, log, cancelled)
        step()

    log("Checking that torch and the pipeline import inside the venv")
    info = _probe_runtime(paths)
    if not info.get("cuda"):
        raise MirrorInstallError("torch sees no CUDA GPU; WorldMirror cannot run on this machine")
    manifest: dict[str, Any] = {
        "revision": rt.CODE_REVISION,
        "weights_revision": rt.WEIGHTS_REVISION,
        "torch": info.get("torch"),
        "device": info.get("device"),
        "installed_at": int(time.time()),
    }
    paths.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    log(f"WorldMirror ready: torch {manifest['torch']} on {manifest['device']}")
    return manifest


def _rmtree(path: Path) -> None:
    """``shutil.rmtree`` that also removes git's read-only objects on Windows."""

    def retry(func: Callable[[str], Any], target: str, _exc: Any) -> None:
        os.chmod(target, stat.S_IWRITE)
        func(target)

    shutil.rmtree(path, onerror=retry)


def uninstall(paths: MirrorPaths, remove_models: bool = True, log: LogFn = print) -> None:
    """Delete the venv and code (and optionally the weights). Other files in the directory stay."""
    if paths.venv.exists() and not paths.python.is_file():
        raise MirrorInstallError(f"{paths.venv} does not look like a venv; not deleting it")
    _remove_file(paths.manifest)
    targets = [paths.venv, paths.root / "uv-cache"]
    if paths.pipeline.is_file():
        targets.append(paths.source)
    for target in targets:
        if target.exists():
            log(f"Removing {target}")
            _rmtree(target)
    if remove_models:
        for spec in rt.MODEL_FILES:
            f = paths.file(spec)
            for each in (f, f.with_name(f.name + ".part")):
                if each.exists():
                    log(f"Removing {each}")
                    _remove_file(each)


# --------------------------------------------------------------------------- doctor


def doctor(paths: MirrorPaths, license_accepted: bool,
           cancelled: Callable[[], bool] = NotCancelled) -> dict[str, Any]:
    """Check every piece, including checksums. Never modifies anything.

    Returns ``{ok, checks: [{name, ok, detail}], action}`` where ``action`` is what
    :func:`repair` would do: ``None``, ``"install"`` (fill in) or ``"reinstall"``
    (rebuild the venv from scratch).
    """
    checks: list[dict[str, Any]] = []
    rebuild = update = False

    def check(name: str, ok: bool, detail: str) -> bool:
        checks.append({"name": name, "ok": ok, "detail": detail})
        return ok

    check("licence", license_accepted, "accepted" if license_accepted else f"not accepted — {rt.LICENSE_URL}")
    uv = shutil.which("uv")
    check("uv", uv is not None, uv or "uv not on PATH: https://docs.astral.sh/uv/")
    source_ok = code_ok(paths)
    if not source_ok:
        git = shutil.which("git")
        check("git", git is not None, git or "git not on PATH (needed to fetch the code)")
    if not check("code", source_ok, f"{paths.source} at {rt.CODE_REVISION[:12]}" if source_ok
                 else f"{paths.source} missing or not at {rt.CODE_REVISION[:12]}"):
        update = True
    for spec in rt.MODEL_FILES:
        ok, detail = verify_file(paths.file(spec), spec, cancelled)
        if not check(Path(spec.rel).name, ok, detail):
            update = True
    if check("venv", paths.python.is_file(), str(paths.python) if paths.python.is_file()
             else f"no python at {paths.python}"):
        if source_ok:
            try:
                info = _probe_runtime(paths)
                if not check("torch + CUDA", bool(info.get("cuda")),
                             f"torch {info.get('torch')}, " + (
                                 f"CUDA on {info.get('device')}" if info.get("cuda") else "CPU only")):
                    rebuild = True
            except (MirrorInstallError, ValueError, IndexError) as e:
                check("imports", False, str(e))
                update = True
    else:
        update = True
    recorded = paths.manifest.is_file()
    if not check("install record", recorded, str(paths.manifest) if recorded else "not verified by an install yet"):
        update = True

    action = "reinstall" if rebuild else "install" if update else None
    return {"ok": all(c["ok"] for c in checks), "checks": checks, "action": action}


def repair(paths: MirrorPaths, license_accepted: bool, log: LogFn = print,
           cancelled: Callable[[], bool] = NotCancelled) -> dict[str, Any]:
    """Run :func:`doctor`, then fix whatever it found (no-op when healthy)."""
    report = doctor(paths, license_accepted, cancelled)
    for c in report["checks"]:
        log(f"[{'ok' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
    if report["action"] is None:
        log("Nothing to repair." if report["ok"] else "Remaining problems cannot be repaired automatically.")
        return report
    log(f"Repair: {report['action']}")
    install(paths, license_accepted, log, force=report["action"] == "reinstall", cancelled=cancelled)
    return doctor(paths, license_accepted, cancelled)
