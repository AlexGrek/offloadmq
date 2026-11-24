"""Install / verify / remove what ``world.pano360`` needs beyond ComfyUI itself.

The only download is WorldGen's 35 MB panorama LoRA (Apache-2.0), fetched into
ComfyUI's own ``loras`` folder (or ``pano360_lora_dir``) and sha256-verified.
The FLUX.1-dev UNET, CLIP-L, T5-XXL and VAE are shared with image generation:
:func:`doctor` reports them, but they are the operator's to provide.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import requests

from offloadmq_agent.exec.world import pano360_runtime as rt

from offloadmq_core.install_job import InstallJob, LogFn


class Pano360InstallError(RuntimeError):
    pass


class Pano360InstallJob(InstallJob):
    def __init__(self) -> None:
        super().__init__("pano360", Pano360InstallError)


def file_sha256(path: Path, cancelled: Callable[[], bool] = lambda: False) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            if cancelled():
                raise Pano360InstallError("cancelled")
            h.update(chunk)
    return h.hexdigest()


def lora_path(settings: Mapping[str, Any]) -> Path:
    try:
        return rt.lora_target_dir(settings) / rt.LORA_NAME
    except RuntimeError as exc:
        raise Pano360InstallError(str(exc)) from exc


def installed_lora(settings: Mapping[str, Any]) -> Path | None:
    """The LoRA file ComfyUI would load: the install folder first, then every ``loras``
    folder ComfyUI scans (an operator may have copied it elsewhere)."""
    candidates = [lora_path(settings)]
    try:
        candidates += [Path(d) / rt.LORA_NAME for d in rt.comfy_lora_dirs(rt.comfy_url(settings))]
    except (requests.RequestException, ValueError):
        pass
    return next((c for c in candidates if c.is_file()), None)


def verify_lora(path: Path, cancelled: Callable[[], bool] = lambda: False) -> tuple[bool, str]:
    if not path.is_file():
        return False, f"{path} missing"
    size = path.stat().st_size
    if size != rt.LORA_BYTES:
        return False, f"{path}: {size} bytes, expected {rt.LORA_BYTES}"
    digest = file_sha256(path, cancelled)
    if digest != rt.LORA_SHA256:
        return False, f"{path}: sha256 {digest[:12]}…, expected {rt.LORA_SHA256[:12]}…"
    return True, f"{path} ({size / 2**20:.1f} MiB, sha256 ok)"


def _download(url: str, dest: Path, log: LogFn, cancelled: Callable[[], bool]) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    log(f"Downloading {url} -> {dest}")
    h = hashlib.sha256()
    try:
        with requests.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()
            with part.open("wb") as f:
                for chunk in r.iter_content(chunk_size=1 << 20):
                    if cancelled():
                        raise Pano360InstallError("cancelled")
                    f.write(chunk)
                    h.update(chunk)
        if h.hexdigest() != rt.LORA_SHA256:
            raise Pano360InstallError(f"download checksum mismatch: sha256 {h.hexdigest()}")
        os.replace(part, dest)
    finally:
        part.unlink(missing_ok=True)


def install(settings: Mapping[str, Any], log: LogFn = print, force: bool = False,
            cancelled: Callable[[], bool] = lambda: False) -> str:
    """Download the WorldGen LoRA unless a verified copy is already there. Returns its path."""
    dest = lora_path(settings)
    found = installed_lora(settings)
    if found is not None and not force:
        ok, detail = verify_lora(found, cancelled)
        if ok:
            log(f"Already installed: {detail}")
            return str(found)
    if found is not None and found != dest:
        dest = found  # replace the copy ComfyUI already sees instead of adding a second one
    log(f"WorldGen panorama LoRA — {rt.LORA_LICENSE}")
    try:
        _download(rt.LORA_URL, dest, log, cancelled)
    except requests.RequestException as exc:
        raise Pano360InstallError(f"download failed: {exc}") from exc
    log(f"Installed {dest} (sha256 verified). ComfyUI picks it up on its next model listing.")
    return str(dest)


def uninstall(settings: Mapping[str, Any], log: LogFn = print) -> bool:
    """Delete the LoRA wherever ComfyUI finds it. FLUX models are shared and left alone."""
    removed = False
    while (found := installed_lora(settings)) is not None:
        found.unlink()
        log(f"Removed {found}")
        removed = True
    if not removed:
        log(f"Nothing to remove ({rt.LORA_NAME} not found).")
    return removed


# --------------------------------------------------------------------------- doctor


def doctor(settings: Mapping[str, Any], cancelled: Callable[[], bool] = lambda: False) -> dict[str, Any]:
    """Check ComfyUI, every graph node, each model and the LoRA. Never modifies anything.

    Returns ``{ok, checks: [{name, ok, detail}], action}``; ``action`` is what
    :func:`repair` would do — ``None`` or ``"install"`` (LoRA missing/corrupt).
    Missing FLUX models are reported but not downloadable here.
    """
    from offloadmq_agent.exec.imggen.workflow import _find_workflows_dir
    from offloadmq_agent.exec.world import find_depth_pack

    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str) -> bool:
        checks.append({"name": name, "ok": ok, "detail": detail})
        return ok

    url = rt.comfy_url(settings)
    action: str | None = None
    try:
        r = requests.get(f"{url}/object_info", timeout=30)
        r.raise_for_status()
        info: dict[str, Any] = r.json()
        reachable = check("ComfyUI", True, url)
    except (requests.RequestException, ValueError) as exc:
        info = {}
        reachable = check("ComfyUI", False, f"not reachable at {url}: {type(exc).__name__}")

    if reachable:
        missing_nodes = [n for n in rt.REQUIRED_NODES if n not in info]
        check("nodes", not missing_nodes,
              f"missing {', '.join(missing_nodes)} — update ComfyUI" if missing_nodes
              else f"{len(rt.REQUIRED_NODES)} required nodes present")
        lists = {role: rt.combo_options((info.get(node, {}).get("input", {}).get("required", {}) or {}).get(field))
                 for role, (node, field) in rt.LOADERS.items()}
        models, problems = rt.pick_models(lists, settings)
        for label, value, what in (("FLUX UNET", models.unet, "FLUX.1-dev UNET"),
                                   ("CLIP-L", models.clip_l, "CLIP-L"), ("T5-XXL", models.t5, "T5-XXL"),
                                   ("VAE", models.vae, "FLUX VAE")):
            problem = next((p for p in problems if what in p), None)
            check(label, value is not None, value or problem or "not found")
        check("LoRA in ComfyUI", models.lora is not None,
              models.lora or f"{rt.LORA_NAME} not listed by ComfyUI")
        if models.lora is None:
            action = "install"

    try:
        found = installed_lora(settings)
        ok, detail = verify_lora(found or lora_path(settings), cancelled)
        if not check("LoRA file", ok, detail):
            action = "install"
    except Pano360InstallError as exc:
        check("LoRA folder", False, str(exc))

    workflows_dir = _find_workflows_dir()
    pack = find_depth_pack(workflows_dir)
    check("depth workflow", pack is not None,
          f"img-utils.{pack}" if pack else f"no img-utils depth workflow in {workflows_dir / 'img-utils'}")

    return {"ok": all(c["ok"] for c in checks), "checks": checks, "action": action}


def repair(settings: Mapping[str, Any], log: LogFn = print,
           cancelled: Callable[[], bool] = lambda: False) -> dict[str, Any]:
    """Run :func:`doctor`, then (re)download the LoRA if that is what is wrong."""
    report = doctor(settings, cancelled)
    for c in report["checks"]:
        log(f"[{'ok' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
    if report["action"] == "install":
        log("Repair: downloading the WorldGen LoRA")
        install(settings, log, force=True, cancelled=cancelled)
        return doctor(settings, cancelled)
    if not report["ok"]:
        log("Remaining problems are not downloadable here: install the FLUX.1-dev models in ComfyUI, "
            "copy the img-utils depth workflow, or pick models with `omq pano360 config`.")
    else:
        log("Nothing to repair.")
    return report
