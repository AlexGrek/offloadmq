"""omq — OffloadMQ agent CLI manager."""
from __future__ import annotations

import asyncio
import json
import signal
import sys
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from offloadmq_agent.agent import Agent
from offloadmq_agent.capabilities import detect_capabilities
from offloadmq_agent.client import OffloadMQClient
from offloadmq_agent.config import AgentConfig, load_config, save_config

app = typer.Typer(name="omq", help="OffloadMQ agent v2 CLI", no_args_is_help=True)
console = Console()


# ------------------------------------------------------------------
# serve
# ------------------------------------------------------------------


@app.command()
def serve(
    server: Optional[str] = typer.Option(None, "--server", "-s", help="OffloadMQ server URL"),
    api_key: Optional[str] = typer.Option(None, "--api-key", "-k", help="Agent API key"),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    """Register and start polling for tasks (headless)."""
    cfg = load_config()
    if server:
        cfg.server = server
    if api_key:
        cfg.api_key = api_key

    if not cfg.is_configured:
        console.print("[red]Agent is not configured. Run [bold]omq config set[/bold] first.[/red]")
        raise typer.Exit(1)

    agent = Agent(cfg)

    def _log(msg: str) -> None:
        if verbose:
            console.print(msg)
        else:
            console.print(f"[dim]{msg}[/dim]")

    agent.set_log_handler(_log)

    loop = asyncio.new_event_loop()

    def _shutdown(sig: int, _: object) -> None:
        console.print(f"\n[yellow]Signal {sig} — shutting down…[/yellow]")
        loop.create_task(agent.stop())

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    console.print(f"[green]Starting agent → {cfg.server}[/green]")
    try:
        loop.run_until_complete(agent.start())
    except Exception as exc:
        console.print(f"[red]Fatal: {exc}[/red]")
        raise typer.Exit(1)
    finally:
        loop.close()


# ------------------------------------------------------------------
# config
# ------------------------------------------------------------------


config_app = typer.Typer(help="Manage agent configuration")
app.add_typer(config_app, name="config")


@config_app.command("show")
def config_show() -> None:
    """Print current configuration."""
    cfg = load_config()
    console.print_json(cfg.model_dump_json(indent=2))


@config_app.command("set")
def config_set(
    server: Optional[str] = typer.Option(None, "--server", "-s"),
    api_key: Optional[str] = typer.Option(None, "--api-key", "-k"),
    tier: Optional[int] = typer.Option(None, "--tier"),
    capacity: Optional[int] = typer.Option(None, "--capacity"),
    autostart: Optional[bool] = typer.Option(None, "--autostart/--no-autostart"),
) -> None:
    """Update configuration fields."""
    cfg = load_config()
    if server is not None:
        cfg.server = server
    if api_key is not None:
        cfg.api_key = api_key
    if tier is not None:
        cfg.tier = tier
    if capacity is not None:
        cfg.capacity = capacity
    if autostart is not None:
        cfg.autostart = autostart
    save_config(cfg)
    console.print("[green]Configuration saved.[/green]")


# ------------------------------------------------------------------
# capabilities
# ------------------------------------------------------------------


@app.command()
def capabilities() -> None:
    """Detect and list available capabilities."""
    console.print("[dim]Detecting capabilities…[/dim]")
    caps = asyncio.run(detect_capabilities())

    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Capability")
    for cap in caps:
        table.add_row(cap)
    console.print(table)


# ------------------------------------------------------------------
# register
# ------------------------------------------------------------------


@app.command()
def register(
    server: Optional[str] = typer.Option(None, "--server", "-s"),
    api_key: Optional[str] = typer.Option(None, "--api-key", "-k"),
) -> None:
    """Register this agent with the OffloadMQ server and save credentials."""
    cfg = load_config()
    if server:
        cfg.server = server
    if api_key:
        cfg.api_key = api_key

    if not cfg.is_configured:
        console.print("[red]Set --server and --api-key first.[/red]")
        raise typer.Exit(1)

    async def _run() -> None:
        reg = await OffloadMQClient.register(
            cfg.server, cfg.api_key, cfg.all_capabilities, cfg.tier, cfg.capacity
        )
        cfg.agent_id = reg.agent_id
        cfg.key = reg.key
        auth = await OffloadMQClient.authenticate(cfg.server, reg.agent_id, reg.key)
        cfg.jwt_token = auth.token
        cfg.token_expires_in = auth.expires_in
        save_config(cfg)
        console.print(f"[green]Registered as[/green] {reg.agent_id}")

    asyncio.run(_run())


# ------------------------------------------------------------------
# status
# ------------------------------------------------------------------


@app.command()
def status() -> None:
    """Show agent status from saved config."""
    cfg = load_config()
    if not cfg.is_configured:
        console.print("[yellow]Not configured.[/yellow]")
        return

    table = Table(show_header=False, box=None)
    table.add_column("Field", style="dim")
    table.add_column("Value")
    table.add_row("Server", cfg.server)
    table.add_row("Agent ID", cfg.agent_id or "(not registered)")
    table.add_row("Tier", str(cfg.tier))
    table.add_row("Capacity", str(cfg.capacity))
    table.add_row("Capabilities", ", ".join(cfg.all_capabilities) or "none")
    console.print(table)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
