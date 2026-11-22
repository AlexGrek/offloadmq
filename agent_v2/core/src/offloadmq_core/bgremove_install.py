"""Install / verify / remove the background-removal models behind ``onnx.bgremove.*``.

Nothing is downloaded with the agent. ``omq bgremove install`` and the GUI's
Background removal page call :func:`install`, which fetches the BiRefNet
exports into ``onnx_models_dir`` through the shared ONNX registry (md5-verified,
same files ``slavemode.onnx-models-prepare`` downloads). :func:`doctor` checks
onnxruntime, the configured device, the directory and every installed model's
checksum; :func:`repair` re-downloads whatever it found broken.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from offloadmq_agent import onnx_models
from offloadmq_agent.exec import bgremove_runtime as rt

from offloadmq_core.install_job import InstallJob, LogFn


class BgRemoveInstallError(RuntimeError):
    pass


class BgRemoveInstallJob(InstallJob):
    def __init__(self) -> None:
        super().__init__("background-removal", BgRemoveInstallError)


def resolve_models(names: Iterable[str] | None, default_all: bool = False) -> list[str]:
    """CLI/GUI model names → registry names. Empty → the default model (or all)."""
    picked = [n for n in (names or []) if n and n.strip()]
    if not picked:
        return rt.model_names() if default_all else [rt.DEFAULT_MODEL]
    try:
        return list(dict.fromkeys(rt.normalize_model(n) for n in picked))
    except rt.BgRemoveConfigError as exc:
        raise BgRemoveInstallError(str(exc)) from exc


def install(
    models: Iterable[str] | None,
    settings: Mapping[str, Any],
    log: LogFn = print,
    force: bool = False,
    cancelled: Callable[[], bool] = lambda: False,
) -> list[str]:
    """Download the given models (default: birefnet-general); returns their paths.

    Already-present models are skipped unless ``force`` (delete + re-download).
    """
    names = resolve_models(models)
    root = onnx_models.models_dir(settings)
    log(f"models dir: {root}")
    paths: list[str] = []
    for name in names:
        if cancelled():
            raise BgRemoveInstallError("cancelled")
        if force and onnx_models.delete_model(name, settings):
            log(f"force: removed existing {name}")
        try:
            path = onnx_models.prepare_model(
                name, log, settings=settings, cancelled=cancelled, progress_step=10,
            )
        except onnx_models.DownloadCancelled as exc:
            raise BgRemoveInstallError("cancelled") from exc
        paths.append(str(path))
    log(f"Installed: {', '.join(rt.short_name(n) for n in names)}")
    return paths


def uninstall(models: Iterable[str] | None, settings: Mapping[str, Any], log: LogFn = print) -> list[str]:
    """Delete the given models (default: every background-removal model). Returns what was removed."""
    removed: list[str] = []
    for name in resolve_models(models, default_all=True):
        if onnx_models.delete_model(name, settings):
            log(f"Removed {name}")
            removed.append(name)
    if not removed:
        log("Nothing to remove.")
    return removed


# --------------------------------------------------------------------------- doctor


def _dir_writable(path: os.PathLike[str] | str) -> tuple[bool, str]:
    p = os.fspath(path)
    try:
        os.makedirs(p, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=p, prefix=".omq-write-test-"):
            pass
    except OSError as exc:
        return False, f"{p}: {exc}"
    return True, p


def doctor(settings: Mapping[str, Any], cancelled: Callable[[], bool] = lambda: False) -> dict[str, Any]:
    """Check every piece. Never modifies anything (md5 reads each installed model: seconds per GB).

    Returns ``{ok, checks: [{name, ok, detail}], action, redownload}``: ``action``
    is what :func:`repair` would do — ``None``, ``"install"`` (no model yet) or
    ``"redownload"`` (models in ``redownload`` are corrupt). A bad device setting
    is reported but not repairable automatically (change it with ``config``).
    """
    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: str) -> bool:
        checks.append({"name": name, "ok": ok, "detail": detail})
        return ok

    cfg = rt.BgRemoveConfig.from_settings(settings)
    version = rt.onnxruntime_version()
    available = rt.available_providers()
    if check("onnxruntime", available is not None,
             f"{version}, providers: {', '.join(available or [])}" if available is not None
             else "onnxruntime is not installed in this agent build"):
        try:
            providers = rt.resolve_providers(cfg.device, available or [])
            check("device", True, f"{cfg.device} -> {providers[0]}"
                  + (f", {cfg.threads} threads" if cfg.threads else ""))
        except rt.BgRemoveConfigError as exc:
            check("device", False, str(exc))

    root = onnx_models.models_dir(settings)
    check("models dir", *_dir_writable(root))

    redownload: list[str] = []
    installed = 0
    for name in rt.model_names():
        meta = onnx_models.ONNX_MODEL_REGISTRY[name]
        path = root / str(meta["filename"])
        if not path.is_file():
            partial = path.with_suffix(".download")
            if partial.is_file():  # an interrupted download: finish it
                check(rt.short_name(name), False, f"interrupted download {partial}")
                redownload.append(name)
            continue
        if cancelled():
            raise BgRemoveInstallError("cancelled")
        installed += 1
        ok, detail = onnx_models.verify_model(name, settings)
        if not check(rt.short_name(name), ok, detail):
            redownload.append(name)

    check("installed", installed > 0,
          f"{installed} model(s)" if installed else "no model installed (default: birefnet-general)")

    action = "redownload" if redownload else "install" if installed == 0 else None
    return {
        "ok": all(c["ok"] for c in checks),
        "checks": checks,
        "action": action,
        "redownload": list(dict.fromkeys(redownload)),
    }


def repair(settings: Mapping[str, Any], log: LogFn = print,
           cancelled: Callable[[], bool] = lambda: False) -> dict[str, Any]:
    """Run :func:`doctor`, then re-download corrupt models / install the default one."""
    report = doctor(settings, cancelled)
    for c in report["checks"]:
        log(f"[{'ok' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
    if report["action"] is None:
        device = next((c for c in report["checks"] if c["name"] == "device"), None)
        if device is not None and not device["ok"]:
            log("Fix the device with `omq bgremove config --device auto` (not repairable by download).")
        else:
            log("Nothing to repair.")
        return report
    if report["action"] == "install":
        log("Repair: installing the default model")
        install(None, settings, log, cancelled=cancelled)
    else:
        log(f"Repair: re-downloading {', '.join(rt.short_name(n) for n in report['redownload'])}")
        install(report["redownload"], settings, log, force=True, cancelled=cancelled)
    return doctor(settings, cancelled)
