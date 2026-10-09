"""omq — OffloadMQ agent v2 CLI.

Mirrors the old agent's command surface (serve / webui / register / config /
capabilities / status) but drives the new core Orchestrator internally.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Optional

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
) -> None:
    """Update settings fields."""
    fields = {
        "server": server,
        "api_key": api_key,
        "max_concurrent": max_concurrent,
        "autostart": autostart,
    }
    _orch().update_settings(**{k: v for k, v in fields.items() if v is not None})
    console.print("[green]Settings saved.[/green]")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
