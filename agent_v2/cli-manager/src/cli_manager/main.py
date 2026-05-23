"""omq — OffloadMQ agent v2 CLI.

Mirrors the old agent's command surface (serve / webui / register / config /
capabilities / status) but drives the new core Orchestrator internally.
"""
from __future__ import annotations

import threading
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from offloadmq_core import Orchestrator, run_blocking

app = typer.Typer(name="omq", help="OffloadMQ agent v2 CLI", no_args_is_help=True)
console = Console()


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
# serve — headless polling, no UI
# ------------------------------------------------------------------


@app.command()
def serve() -> None:
    """Start the agent and poll for tasks (headless, no web UI)."""
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
    port: int = typer.Option(8090, "--port", "-p"),
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
    console.print(f"[green]Web UI →[/green] http://{host}:{port}")
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
