import typer
from .ollama import *
from .config import *
from .systeminfo import *
from .models import *
from .httphelpers import *
from .core import serve_tasks


app = typer.Typer(add_completion=False, no_args_is_help=True, help="Offload Client CLI")


@app.command("sysinfo", help="Display system information")
def cli_sysinfo():
    print_system_info(collect_system_info())


@app.command("ollama", help="Display detected Ollama models")
def cli_ollama():
    caps = get_ollama_models()
    if caps:
        typer.echo("Detected Ollama capabilities:")
        for c in caps:
            typer.echo(f" - {c}")
    else:
        typer.echo("No Ollama capabilities detected.")


@app.command("register", help="Register a new agent with the server")
def cli_register(
    server: Optional[str] = typer.Option(
        None, help="Server URL (required if not in config)"
    ),
    key: Optional[str] = typer.Option(None, help="API key (required if not in config)"),
    tier: int = typer.Option(5, help="Performance tier (0-255)"),
    caps: List[str] = typer.Option(
        ["debug::echo", "shell::bash"], help="Agent capabilities"
    ),
    capacity: int = typer.Option(1, help="Concurrent task capacity"),
):
    cfg = load_config()
    server = server or cfg.get("server")
    api_key = key or cfg.get("apiKey")

    if not server:
        typer.echo(
            "Error: Server URL must be provided via --server or stored in config"
        )
        raise typer.Exit(code=1)
    if not api_key:
        typer.echo("Error: API key must be provided via --key or stored in config")
        raise typer.Exit(code=1)

    sysinfo = collect_system_info()
    print_system_info(sysinfo)

    ollama_models = get_ollama_models()
    combined_caps = sorted(set(list(caps) + ollama_models))

    typer.echo(f"\nRegistering with server: {server}")
    typer.echo(f"Capabilities: {combined_caps}")

    try:
        reg = register_agent(server, combined_caps, tier, capacity, api_key)
    except requests.RequestException as e:
        typer.echo(f"Error registering agent: {e}")
        raise typer.Exit(code=1)

    typer.echo("\nRegistration successful!")

    cfg.update(
        {
            "server": server,
            "apiKey": api_key,
            "agentId": reg["agentId"],
            "key": reg["key"],
        }
    )

    typer.echo("\nAuthenticating...")
    try:
        auth = authenticate_agent(server, reg["agentId"], reg["key"])
    except requests.RequestException as e:
        typer.echo(f"Authentication failed: {e}")
        raise typer.Exit(code=1)

    typer.echo("Authentication successful!")

    cfg.update({"jwtToken": auth["token"], "tokenExpiresIn": auth.get("expiresIn")})
    save_config(cfg)
    typer.echo(f"Configuration saved to {CONFIG_FILE}")

    typer.echo("\nTesting connection...")
    if test_ping(server, auth["token"]):
        typer.echo("✅ Ping test successful - agent is ready!")
    else:
        typer.echo("❌ Ping test failed - check server connection")
        raise typer.Exit(code=1)


@app.command("serve", help="Poll for and execute tasks")
def cli_serve(
    server: Optional[str] = typer.Option(
        None, help="Server URL (required if not in config)"
    )
):
    cfg = load_config()
    server = server or cfg.get("server")
    if not server:
        typer.echo("Error: Server URL must be provided via --server or in config")
        raise typer.Exit(code=1)

    agent_id = cfg.get("agentId")
    key = cfg.get("key")
    if not (agent_id and key):
        typer.echo(
            "Error: Agent not registered or config incomplete. Run 'register' first."
        )
        raise typer.Exit(code=1)

    # Ensure local Ollama availability (non-fatal)
    typer.echo("\nChecking for local Ollama server...")
    if is_ollama_server_running():
        typer.echo("✅ Ollama server is already running.")
    else:
        if not start_ollama_server():
            typer.echo(
                "Warning: Continuing without a confirmed Ollama server. LLM tasks may fail."
            )

    typer.echo("\nAuthenticating to get a fresh JWT token...")
    try:
        auth = authenticate_agent(server, agent_id, key)
    except requests.RequestException as e:
        typer.echo(f"Authentication failed: {e}")
        raise typer.Exit(code=1)

    jwt = auth["token"]
    cfg["jwtToken"] = jwt
    save_config(cfg)

    typer.echo("Starting task polling...")
    serve_tasks(server, jwt)
