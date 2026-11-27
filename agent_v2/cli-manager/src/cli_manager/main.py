"""omq — OffloadMQ agent v2 CLI.

Commands: serve / webui / register / config / capabilities / status / update,
all driving the core Orchestrator.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Optional

import typer
from rich.console import Console
from rich.table import Table

from offloadmq_core import Orchestrator, run_blocking
from offloadmq_core.settings import DEFAULT_WEBUI_PORT
from offloadmq_core.version import set_app_version

from cli_manager._version import __version__ as _BAKED_VERSION

app = typer.Typer(name="omq", help="OffloadMQ agent v2 CLI", no_args_is_help=True)
console = Console()

#: Sentinel meaning the release tooling did not stamp a version (dev build).
_DEV_SENTINEL = "0.0.0.dev0"


def _resolve_version() -> str:
    """Return the CLI version.

    Prefers the value stamped into ``_version.py`` by the release tooling;
    in an unstamped dev build, falls back to the installed package metadata.
    """
    if _BAKED_VERSION and _BAKED_VERSION != _DEV_SENTINEL:
        return _BAKED_VERSION
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            return version("offloadmq-cli")
        except PackageNotFoundError:
            return _BAKED_VERSION
    except Exception:  # noqa: BLE001
        return _BAKED_VERSION


# Only a release-stamped version: the package-metadata fallback would make an
# unstamped local build look like an old release and auto-update itself away.
set_app_version(_BAKED_VERSION)


def _version_callback(value: bool) -> None:
    if value:
        console.print(_resolve_version())
        raise typer.Exit()


@app.callback()
def _main(
    version: bool = typer.Option(
        False,
        "--version",
        "-V",
        help="Show the omq version and exit.",
        callback=_version_callback,
        is_eager=True,
    ),
) -> None:
    """OffloadMQ agent v2 CLI."""


def _orch() -> Orchestrator:
    return Orchestrator()


def _block_until_interrupt(orch: Orchestrator) -> None:
    stop = threading.Event()
    try:
        while not stop.wait(1.0):
            if not orch.is_running():
                console.print("[yellow]Agent stopped.[/yellow]")
                break
    except KeyboardInterrupt:
        console.print("\n[yellow]Shutting down…[/yellow]")
    finally:
        orch.stop()


# ------------------------------------------------------------------
# serve — headless, no UI
# ------------------------------------------------------------------


@app.command()
def serve() -> None:
    """Start the agent (headless, no web UI). Tasks are pushed over the agent
    WebSocket — the agent never polls for them."""
    orch = _orch()
    try:
        orch.start()
    except RuntimeError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print("[green]Agent started.[/green] Press Ctrl-C to stop.")
    _block_until_interrupt(orch)


# ------------------------------------------------------------------
# webui — run the web dashboard (optionally start the agent too)
# ------------------------------------------------------------------


@app.command()
def webui(
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(DEFAULT_WEBUI_PORT, "--port", "-p"),
    start: bool = typer.Option(False, "--start", help="Also start the agent"),
) -> None:
    """Serve the web dashboard at http://host:port (Ctrl-C to stop)."""
    orch = _orch()
    if start or orch.get_settings().autostart:
        try:
            orch.start()
            console.print("[green]Agent started.[/green]")
        except RuntimeError as exc:
            console.print(f"[yellow]Agent not started: {exc}[/yellow]")
    console.print(f"[green]Web UI ->[/green] http://{host}:{port}")
    try:
        run_blocking(orch, host=host, port=port)
    except KeyboardInterrupt:
        pass
    finally:
        orch.stop()


# ------------------------------------------------------------------
# register
# ------------------------------------------------------------------


@app.command()
def register() -> None:
    """Register this agent with the server and store credentials."""
    orch = _orch()
    try:
        agent_id = orch.register()
    except Exception as exc:  # noqa: BLE001
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print(f"[green]Registered as[/green] {agent_id}")


# ------------------------------------------------------------------
# capabilities
# ------------------------------------------------------------------


@app.command()
def capabilities() -> None:
    """Detect and list available capabilities."""
    console.print("[dim]Detecting…[/dim]")
    caps = _orch().scan_capabilities()
    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Capability")
    for cap in caps:
        table.add_row(cap)
    console.print(table)


# ------------------------------------------------------------------
# status
# ------------------------------------------------------------------


@app.command()
def status() -> None:
    """Show agent configuration and status."""
    orch = _orch()
    info = orch.status()
    table = Table(show_header=False, box=None)
    table.add_column("Field", style="dim")
    table.add_column("Value")
    table.add_row("Server", info["server"] or "(unset)")
    table.add_row("Agent ID", info["agentId"] or "(not registered)")
    table.add_row("Running", str(info["running"]))
    table.add_row("Capabilities", ", ".join(info["capabilities"]) or "none")
    table.add_row("Max concurrent", str(info["maxConcurrent"]))
    console.print(table)


# ------------------------------------------------------------------
# update
# ------------------------------------------------------------------


@app.command()
def update(
    check: bool = typer.Option(False, "--check", help="Only report whether an update exists"),
    rollback: bool = typer.Option(
        False, "--rollback", help="Restore the binary replaced by the last update"
    ),
) -> None:
    """Replace this omq binary with the latest release (Linux only).

    Restart the service afterwards: systemctl --user restart offloadmq-agent
    """
    from offloadmq_core import updater
    from offloadmq_core.version import get_app_version

    def log(msg: str) -> None:
        console.print(f"[dim]{msg}[/dim]")

    current = get_app_version()
    if rollback:
        result = updater.rollback(log)
    elif check:
        info = updater.check_for_update(current)
        if "error" in info:
            console.print(f"[red]{info['error']}[/red]")
            raise typer.Exit(1)
        verdict = "[green]update available[/green]" if info["has_update"] else "up to date"
        console.print(f"current {current} · latest {info['latest']} · {verdict}")
        return
    else:
        result = updater.download_update(current, log)

    if not result["ok"]:
        console.print(f"[red]{result['error']}[/red]")
        raise typer.Exit(1)
    console.print(f"[green]{result['message']}[/green]")


@app.command(hidden=True)
def selftest() -> None:
    """Check this build can make verified TLS connections (run by the self-updater)."""
    from offloadmq_core import updater

    try:
        updater.tls_selftest()
    except Exception as exc:  # noqa: BLE001
        console.print(f"[red]selftest failed: {exc}[/red]")
        raise typer.Exit(1)
    console.print("[green]ok[/green]")


# ------------------------------------------------------------------
# comfy — workflow export / import
# ------------------------------------------------------------------


comfy_app = typer.Typer(help="ComfyUI workflows: list, export and import (graphs + param maps)")
app.add_typer(comfy_app, name="comfy")


@comfy_app.command("list")
def comfy_list() -> None:
    """List installed ComfyUI workflows."""
    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Workflow")
    table.add_column("Task types")
    for w in _orch().list_comfy_workflows()["workflows"]:
        table.add_row(f"{w['namespace'] or 'imggen'}.{w['name']}", ", ".join(w["task_types"]))
    console.print(table)


@comfy_app.command("export")
def comfy_export(
    workflow: str = typer.Argument(..., help="e.g. my-sdxl, imggen.my-sdxl or img-utils.depth"),
    output: Optional[Path] = typer.Option(
        None, "--output", "-o", help="Bundle file to write (default: [<ns>.]<name>.omqwf.json; '-' = stdout)"
    ),
) -> None:
    """Export a workflow (all task types, with their param maps) to one JSON bundle."""
    from offloadmq_core.comfy_service import parse_workflow_ref

    name, namespace = parse_workflow_ref(workflow)
    try:
        bundle = _orch().export_comfy_workflow(name, namespace)
    except (ValueError, OSError) as exc:  # FileNotFoundError is an OSError
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    text = json.dumps(bundle, indent=2)
    if output is not None and str(output) == "-":
        typer.echo(text)
        return
    dest = output or Path(f"{namespace + '.' if namespace else ''}{name}.omqwf.json")
    try:
        dest.write_text(text)
    except OSError as exc:
        console.print(f"[red]Cannot write {dest}: {exc}[/red]")
        raise typer.Exit(1)
    mapped = sum(1 for t in bundle["task_types"].values() if t["params"] is not None)
    console.print(
        f"[green]Exported[/green] {workflow} ({len(bundle['task_types'])} task types, "
        f"{mapped} with param maps) -> {dest}"
    )


@comfy_app.command("import")
def comfy_import(
    file: Path = typer.Argument(..., exists=True, dir_okay=False, help="Bundle from `omq comfy export`"),
    name: str = typer.Option("", "--name", "-n", help="Install under this workflow name"),
    namespace: Optional[str] = typer.Option(
        None, "--namespace", help="Override namespace: img-utils, txt2music, or '' for imggen"
    ),
    overwrite: bool = typer.Option(False, "--overwrite", help="Replace task types that already exist"),
) -> None:
    """Install a workflow bundle, including its configured param maps."""
    try:
        bundle = json.loads(file.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        console.print(f"[red]Cannot read {file}: {exc}[/red]")
        raise typer.Exit(1)
    try:
        result = _orch().import_comfy_workflow(bundle, name, namespace, overwrite)
    except FileExistsError as exc:
        console.print(f"[red]{exc}[/red] (use --overwrite to replace)")
        raise typer.Exit(1)
    except (ValueError, OSError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print(
        f"[green]Imported[/green] {result['namespace'] or 'imggen'}.{result['name']} "
        f"({', '.join(result['task_types'])}). Restart or rescan the agent to advertise it."
    )


# ------------------------------------------------------------------
# sharp
# ------------------------------------------------------------------


sharp_app = typer.Typer(
    help="Apple SHARP runtime behind world.sharp (image -> Gaussian splat). Installed on demand only."
)
app.add_typer(sharp_app, name="sharp")


def _sharp_ctx() -> tuple[Any, str]:
    """(paths, torch_index) from the agent settings."""
    from offloadmq_core.sharp_install import SharpPaths

    settings = _orch().get_settings()
    return SharpPaths.from_settings(settings.model_dump()), settings.sharp_torch_index


def _plain(line: str) -> None:
    console.print(line, markup=False, highlight=False)


@sharp_app.command("status")
def sharp_status() -> None:
    """Show where SHARP lives and whether it is installed (fast; no imports)."""
    from offloadmq_core.sharp_install import rt

    paths, index = _sharp_ctx()
    st = rt.status(paths)
    _plain(st.describe())
    _plain(f"venv dir:    {paths.venv}")
    _plain(f"models dir:  {paths.models}")
    _plain(f"torch index: {index}")
    if not st.ready:
        raise typer.Exit(1)


@sharp_app.command("config")
def sharp_config(
    venv_dir: Optional[str] = typer.Option(None, "--venv-dir", help="Where to build the venv ('' = default)"),
    models_dir: Optional[str] = typer.Option(None, "--models-dir", help="Where to keep the 2.8 GB model ('' = default)"),
    torch_index: Optional[str] = typer.Option(None, "--torch-index", help="auto | cuda | cpu | pypi | <index URL>"),
) -> None:
    """Change SHARP locations / torch build. Run `omq sharp install` afterwards for a new location."""
    from offloadmq_core.sharp_install import SharpInstallError, resolve_torch_index

    if torch_index is not None:
        try:
            resolve_torch_index(torch_index)
        except SharpInstallError as exc:
            console.print(f"[red]{exc}[/red]")
            raise typer.Exit(1)
    _orch().update_settings(sharp_venv_dir=venv_dir, sharp_models_dir=models_dir, sharp_torch_index=torch_index)
    sharp_status()


@sharp_app.command("install")
def sharp_install(
    force: bool = typer.Option(False, "--force", help="Rebuild the venv from scratch (keeps a valid model)"),
) -> None:
    """Install or update the SHARP venv + model (needs uv; several GB)."""
    from offloadmq_core.sharp_install import SharpInstallError, install

    paths, index = _sharp_ctx()
    try:
        install(paths, log=_plain, torch_index=index, force=force)
    except SharpInstallError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print("[green]Done.[/green] Restart or rescan the agent to advertise world.sharp.")


@sharp_app.command("doctor")
def sharp_doctor(
    fix: bool = typer.Option(False, "--fix", help="Reinstall whatever is broken or outdated"),
) -> None:
    """Validate source, uv, venv, torch/CUDA, model and version; optionally repair."""
    from offloadmq_core.sharp_install import SharpInstallError, doctor, repair

    paths, index = _sharp_ctx()
    try:
        report = repair(paths, log=_plain, torch_index=index) if fix else doctor(paths, index)
    except SharpInstallError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    if not fix:
        for c in report["checks"]:
            mark = "[green]ok[/green]  " if c["ok"] else "[red]FAIL[/red]"
            console.print(f"{mark} {c['name']}: ", end="")
            _plain(c["detail"])
    if report["ok"]:
        console.print("[green]SHARP is healthy.[/green]")
        return
    if not fix:
        console.print(f"[yellow]Run `omq sharp doctor --fix` to {report['action']}.[/yellow]")
    raise typer.Exit(1)


@sharp_app.command("uninstall")
def sharp_uninstall(
    keep_model: bool = typer.Option(False, "--keep-model", help="Keep the 2.8 GB model file"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Do not ask for confirmation"),
) -> None:
    """Delete the SHARP venv (and the model unless --keep-model)."""
    from offloadmq_core.sharp_install import SharpInstallError, uninstall

    paths, _ = _sharp_ctx()
    what = f"{paths.venv}" + ("" if keep_model else f" and {paths.checkpoint}")
    if not yes and not typer.confirm(f"Delete {what}?"):
        raise typer.Exit(1)
    try:
        uninstall(paths, remove_models=not keep_model, log=_plain)
    except SharpInstallError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print("[green]SHARP removed.[/green] Restart or rescan the agent to stop advertising world.sharp.")


# ------------------------------------------------------------------
# bgremove
# ------------------------------------------------------------------


bgremove_app = typer.Typer(
    help="Background removal (onnx.bgremove.*): models, device and threads. Models download on demand only."
)
app.add_typer(bgremove_app, name="bgremove")

_MODELS_ARG_HELP = "birefnet-general | birefnet-portrait | birefnet-lite"


def _bgremove_settings() -> dict[str, Any]:
    return _orch().get_settings().model_dump()


@bgremove_app.command("status")
def bgremove_status() -> None:
    """Show models, device and where they live (fast; no checksums)."""
    from offloadmq_agent.exec import bgremove_runtime as rt

    st = rt.status(_bgremove_settings())
    _plain(st["summary"])
    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Model")
    table.add_column("Capability")
    table.add_column("Installed")
    table.add_column("Size", justify="right")
    for m in st["models"]:
        size = m["size_bytes"] or m["expected_bytes"] or 0
        mark = "yes" if m["installed"] else "partial" if m["present"] else "no"
        table.add_row(m["short"] + (" (default)" if m["default"] else ""), m["capability"], mark,
                      f"{size / 2**20:.0f} MiB")
    console.print(table)
    _plain(f"models dir:  {st['models_dir']}")
    _plain(f"device:      {st['device']} -> {', '.join(st['providers']) or '-'}")
    _plain(f"threads:     {st['threads'] or 'onnxruntime default'}")
    _plain(f"keep loaded: {st['keep_loaded']}")
    _plain(f"onnxruntime: {st['onnxruntime'] or 'missing'} ({', '.join(st['available_providers'])})")
    if not st["ready"]:
        raise typer.Exit(1)


@bgremove_app.command("config")
def bgremove_config(
    models_dir: Optional[str] = typer.Option(
        None, "--models-dir", help="ONNX models directory, shared with onnx.nudenet ('' = default)"
    ),
    device: Optional[str] = typer.Option(None, "--device", help="auto | cuda | directml | cpu"),
    threads: Optional[int] = typer.Option(None, "--threads", min=0, help="CPU threads per inference (0 = all cores)"),
    keep_loaded: Optional[bool] = typer.Option(
        None, "--keep-loaded/--no-keep-loaded", help="Keep models in RAM between tasks (~4 GB per BiRefNet)"
    ),
) -> None:
    """Change models location, device, threads or session caching. Install again after moving the dir."""
    from offloadmq_agent.exec.bgremove_runtime import BgRemoveConfigError, validate_device

    if device is not None:
        try:
            device = validate_device(device)
        except BgRemoveConfigError as exc:
            console.print(f"[red]{exc}[/red]")
            raise typer.Exit(1)
    _orch().update_settings(
        onnx_models_dir=models_dir, bgremove_device=device,
        bgremove_threads=threads, bgremove_keep_loaded=keep_loaded,
    )
    bgremove_status()


@bgremove_app.command("install")
def bgremove_install(
    models: Optional[list[str]] = typer.Argument(None, help=f"{_MODELS_ARG_HELP} (default: birefnet-general)"),
    all_models: bool = typer.Option(False, "--all", help="Install every background-removal model"),
    force: bool = typer.Option(False, "--force", help="Delete and download again"),
) -> None:
    """Download background-removal models (md5-verified; 224-973 MB each)."""
    from offloadmq_agent.exec import bgremove_runtime as rt
    from offloadmq_core.bgremove_install import BgRemoveInstallError, install

    try:
        install(rt.model_names() if all_models else models, _bgremove_settings(), log=_plain, force=force)
    except (BgRemoveInstallError, RuntimeError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print("[green]Done.[/green] Restart or rescan the agent to advertise onnx.bgremove.*.")


@bgremove_app.command("doctor")
def bgremove_doctor(
    fix: bool = typer.Option(False, "--fix", help="Re-download corrupt models / install the default one"),
) -> None:
    """Validate onnxruntime, device, models dir and every installed model's checksum."""
    from offloadmq_core.bgremove_install import BgRemoveInstallError, doctor, repair

    settings = _bgremove_settings()
    try:
        report = repair(settings, log=_plain) if fix else doctor(settings)
    except (BgRemoveInstallError, RuntimeError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    if not fix:
        for c in report["checks"]:
            mark = "[green]ok[/green]  " if c["ok"] else "[red]FAIL[/red]"
            console.print(f"{mark} {c['name']}: ", end="")
            _plain(c["detail"])
    if report["ok"]:
        console.print("[green]Background removal is healthy.[/green]")
        return
    if not fix and report["action"]:
        console.print(f"[yellow]Run `omq bgremove doctor --fix` to {report['action']}.[/yellow]")
    raise typer.Exit(1)


@bgremove_app.command("uninstall")
def bgremove_uninstall(
    models: Optional[list[str]] = typer.Argument(None, help=f"{_MODELS_ARG_HELP} (default: all of them)"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Do not ask for confirmation"),
) -> None:
    """Delete background-removal model files (onnx.nudenet is never touched)."""
    from offloadmq_core.bgremove_install import BgRemoveInstallError, resolve_models, uninstall

    try:
        names = resolve_models(models, default_all=True)
    except BgRemoveInstallError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    if not yes and not typer.confirm(f"Delete {', '.join(names)}?"):
        raise typer.Exit(1)
    uninstall(names, _bgremove_settings(), log=_plain)
    console.print("[green]Done.[/green] Restart or rescan the agent to stop advertising removed models.")


# ------------------------------------------------------------------
# pano360
# ------------------------------------------------------------------


pano360_app = typer.Typer(
    help="world.pano360 (picture -> outpainted 360 world): FLUX models in ComfyUI + the WorldGen LoRA."
)
app.add_typer(pano360_app, name="pano360")


@pano360_app.command("status")
def pano360_status() -> None:
    """Show which ComfyUI models world.pano360 would use (four small ComfyUI requests)."""
    from offloadmq_agent.exec.world import pano360_runtime as rt

    settings = _orch().get_settings().model_dump()
    st = rt.status(settings, timeout=5)
    _plain(st.describe())
    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Role")
    table.add_column("Model")
    table.add_column("Setting")
    for role, value in st.models.to_dict().items():
        key = rt.SETTING_KEYS.get(role)
        table.add_row(role, value or "-", (f"{key}={settings.get(key) or 'auto'}") if key else "omq pano360 install")
    console.print(table)
    try:
        _plain(f"LoRA folder: {rt.lora_target_dir(settings)}")
    except RuntimeError as exc:
        _plain(f"LoRA folder: {exc}")
    if not st.ready:
        raise typer.Exit(1)


@pano360_app.command("config")
def pano360_config(
    unet: Optional[str] = typer.Option(None, "--unet", help="FLUX.1-dev UNET as ComfyUI lists it ('' = auto)"),
    clip_l: Optional[str] = typer.Option(None, "--clip-l", help="CLIP-L text encoder ('' = auto)"),
    t5: Optional[str] = typer.Option(None, "--t5", help="T5-XXL text encoder ('' = auto, fp8 preferred)"),
    vae: Optional[str] = typer.Option(None, "--vae", help="FLUX VAE ('' = auto, ae.safetensors)"),
    lora_dir: Optional[str] = typer.Option(
        None, "--lora-dir", help="Where install puts the LoRA ('' = ComfyUI's own loras folder)"
    ),
) -> None:
    """Pin models or the LoRA folder. Unset options stay as they are."""
    _orch().update_settings(
        pano360_unet=unet, pano360_clip_l=clip_l, pano360_t5=t5, pano360_vae=vae, pano360_lora_dir=lora_dir,
    )
    pano360_status()


@pano360_app.command("install")
def pano360_install(force: bool = typer.Option(False, "--force", help="Download again")) -> None:
    """Download WorldGen's panorama LoRA (35 MB, Apache-2.0, sha256-verified) into ComfyUI."""
    from offloadmq_core.pano360_install import Pano360InstallError, install

    try:
        install(_orch().get_settings().model_dump(), log=_plain, force=force)
    except (Pano360InstallError, RuntimeError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print("[green]Done.[/green] Restart or rescan the agent to advertise world.pano360.")


@pano360_app.command("doctor")
def pano360_doctor(fix: bool = typer.Option(False, "--fix", help="(Re)download the LoRA if it is missing or corrupt")) -> None:
    """Check ComfyUI nodes, FLUX models, the LoRA checksum and the depth workflow."""
    from offloadmq_core.pano360_install import Pano360InstallError, doctor, repair

    settings = _orch().get_settings().model_dump()
    try:
        report = repair(settings, log=_plain) if fix else doctor(settings)
    except (Pano360InstallError, RuntimeError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    if not fix:
        for c in report["checks"]:
            mark = "[green]ok[/green]  " if c["ok"] else "[red]FAIL[/red]"
            console.print(f"{mark} {c['name']}: ", end="")
            _plain(c["detail"])
    if report["ok"]:
        console.print("[green]world.pano360 is healthy.[/green]")
        return
    if not fix and report["action"]:
        console.print(f"[yellow]Run `omq pano360 doctor --fix` to {report['action']} the LoRA.[/yellow]")
    raise typer.Exit(1)


@pano360_app.command("uninstall")
def pano360_uninstall(yes: bool = typer.Option(False, "--yes", "-y", help="Do not ask for confirmation")) -> None:
    """Delete the WorldGen LoRA (the shared FLUX models are never touched)."""
    from offloadmq_core.pano360_install import Pano360InstallError, lora_path, uninstall

    settings = _orch().get_settings().model_dump()
    try:
        target = lora_path(settings)
    except Pano360InstallError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    if not yes and not typer.confirm(f"Delete {target}?"):
        raise typer.Exit(1)
    uninstall(settings, log=_plain)
    console.print("[green]Done.[/green] Restart or rescan the agent to stop advertising world.pano360.")


# ------------------------------------------------------------------
# mirror
# ------------------------------------------------------------------


mirror_app = typer.Typer(
    help="world.mirror (Tencent WorldMirror 2.0, experimental). Off until its licence is accepted."
)
app.add_typer(mirror_app, name="mirror")


@mirror_app.command("status")
def mirror_status() -> None:
    """Show where WorldMirror lives and whether it is installed (fast; no imports)."""
    from offloadmq_core.mirror_install import rt

    st = rt.status(_orch().get_settings().model_dump())
    _plain(st.describe())
    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Item")
    table.add_column("State")
    table.add_row("directory", str(st.paths.root))
    table.add_row("licence", "accepted" if st.license_accepted else "not accepted")
    table.add_row("unload Ollama", "yes" if rt.free_ollama(_orch().get_settings().model_dump()) else "no")
    table.add_row("venv", "present" if st.has_venv else "missing")
    table.add_row("code", "present" if st.has_code else "missing")
    table.add_row("model", f"{st.model_bytes / 2**30:.2f} GiB" + ("" if st.has_model else " (incomplete)"))
    console.print(table)
    if not st.ready:
        raise typer.Exit(1)


@mirror_app.command("config")
def mirror_config(
    directory: Optional[str] = typer.Option(None, "--dir", help="Runtime directory ('' = default)"),
    accept: Optional[bool] = typer.Option(
        None, "--accept-license/--revoke-license", help="Accept or withdraw the HY-World 2.0 licence"
    ),
    free_ollama: Optional[bool] = typer.Option(
        None, "--free-ollama/--keep-ollama",
        help="Unload Ollama's models before each run (default on; off keeps chat models loaded)",
    ),
) -> None:
    """Set the directory, the licence acceptance or Ollama unloading. Unset options stay as they are."""
    from offloadmq_core.mirror_install import rt

    if accept:
        _plain(f"{rt.LICENSE_NOTICE} {rt.LICENSE_URL}")
    _orch().update_settings(mirror_dir=directory, mirror_license_accepted=accept, mirror_free_ollama=free_ollama)
    mirror_status()


@mirror_app.command("install")
def mirror_install(
    accept: bool = typer.Option(
        False, "--accept-license",
        help="Confirm you may use HY-World 2.0 where you are (not the EU, UK or South Korea) and accept its licence",
    ),
    force: bool = typer.Option(False, "--force", help="Rebuild the venv from scratch"),
) -> None:
    """Build the venv, fetch the pinned code and download the 4.9 GiB of models."""
    from offloadmq_core.mirror_install import MirrorInstallError, MirrorPaths, install, rt

    orch = _orch()
    if accept:
        orch.update_settings(mirror_license_accepted=True)
    settings = orch.get_settings()
    if not settings.mirror_license_accepted:
        _plain(f"{rt.LICENSE_NOTICE} {rt.LICENSE_URL}")
        console.print("[yellow]Re-run with --accept-license if that applies to you.[/yellow]")
        raise typer.Exit(1)
    try:
        install(MirrorPaths.from_settings(settings.model_dump()), True, log=_plain, force=force)
    except (MirrorInstallError, OSError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print("[green]Done.[/green] Restart or rescan the agent to advertise world.mirror.")


@mirror_app.command("doctor")
def mirror_doctor(fix: bool = typer.Option(False, "--fix", help="Install whatever is missing or broken")) -> None:
    """Verify checksums, the code revision, torch/CUDA and the pipeline import."""
    from offloadmq_core.mirror_install import MirrorInstallError, MirrorPaths, doctor, repair

    settings = _orch().get_settings()
    paths = MirrorPaths.from_settings(settings.model_dump())
    accepted = settings.mirror_license_accepted
    if fix and not accepted:
        console.print("[red]Accept the licence first: omq mirror install --accept-license[/red]")
        raise typer.Exit(1)
    try:
        report = repair(paths, accepted, log=_plain) if fix else doctor(paths, accepted)
    except (MirrorInstallError, OSError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    if not fix:
        for c in report["checks"]:
            mark = "[green]ok[/green]  " if c["ok"] else "[red]FAIL[/red]"
            console.print(f"{mark} {c['name']}: ", end="")
            _plain(c["detail"])
    if report["ok"]:
        console.print("[green]world.mirror is healthy.[/green]")
        return
    if not fix and report["action"] and accepted:
        console.print(f"[yellow]Run `omq mirror doctor --fix` to {report['action']}.[/yellow]")
    raise typer.Exit(1)


@mirror_app.command("uninstall")
def mirror_uninstall(
    keep_models: bool = typer.Option(False, "--keep-models", help="Keep the downloaded weights"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Do not ask for confirmation"),
) -> None:
    """Delete the venv, the code and (unless --keep-models) the weights."""
    from offloadmq_core.mirror_install import MirrorInstallError, MirrorPaths, uninstall

    paths = MirrorPaths.from_settings(_orch().get_settings().model_dump())
    what = "venv and code" if keep_models else "venv, code and models"
    if not yes and not typer.confirm(f"Delete the WorldMirror {what} in {paths.root}?"):
        raise typer.Exit(1)
    try:
        uninstall(paths, not keep_models, log=_plain)
    except (MirrorInstallError, OSError) as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print("[green]Done.[/green] Restart or rescan the agent to stop advertising world.mirror.")


# ------------------------------------------------------------------
# config
# ------------------------------------------------------------------


config_app = typer.Typer(help="Manage agent settings")
app.add_typer(config_app, name="config")


@config_app.command("show")
def config_show() -> None:
    """Print current settings as JSON."""
    console.print_json(_orch().get_settings().model_dump_json(indent=2))


@config_app.command("set")
def config_set(
    server: Optional[str] = typer.Option(None, "--server", "-s"),
    api_key: Optional[str] = typer.Option(None, "--api-key", "-k"),
    max_concurrent: Optional[int] = typer.Option(None, "--max-concurrent"),
    autostart: Optional[bool] = typer.Option(None, "--autostart/--no-autostart"),
    shell_workspace_root: Optional[str] = typer.Option(
        None, "--shell-workspace-root",
        help="Base dir for relative shell.* workspaces ('' = ~/.offload-agent/shell-workspaces)",
    ),
    shell_restrict_workspace: Optional[bool] = typer.Option(
        None, "--shell-restrict-workspace/--no-shell-restrict-workspace",
        help="Reject shell.* workspaces outside the workspace root",
    ),
) -> None:
    """Update settings fields."""
    fields = {
        "server": server,
        "api_key": api_key,
        "max_concurrent": max_concurrent,
        "autostart": autostart,
        "shell_workspace_root": shell_workspace_root,
        "shell_restrict_workspace": shell_restrict_workspace,
    }
    _orch().update_settings(**{k: v for k, v in fields.items() if v is not None})
    console.print("[green]Settings saved.[/green]")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
