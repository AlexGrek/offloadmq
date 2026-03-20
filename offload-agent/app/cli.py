import typer
from pathlib import Path
from .ollama import *
from .config import *
from .systeminfo import *
from .models import *
from .httphelpers import *
from .core import serve_tasks
from .websocket_client import serve_websocket


app = typer.Typer(add_completion=False, no_args_is_help=True, help="Offload Agent CLI")
skills_app = typer.Typer(help="Manage custom skills")
app.add_typer(skills_app, name="skills")


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
        ["debug.echo", "shell.bash", "shellcmd.bash", "tts.kokoro"], help="Agent capabilities"
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
    ),
    ws: bool = typer.Option(
        False, "--ws", help="Use WebSocket connection instead of polling"
    ),
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

    if ws:
        typer.echo("Starting WebSocket connection...")
        serve_websocket(server, jwt)
    else:
        typer.echo("Starting task polling...")
        serve_tasks(server, jwt)


@skills_app.command("list", help="List all discovered skills")
def cli_skills_list():
    from .skills import discover_skills, _find_skills_dir

    skills_dir = _find_skills_dir()
    typer.echo(f"Skills directory: {skills_dir}\n")

    skills = discover_skills()
    if not skills:
        typer.echo("No skills found. Create .yaml files in the skills directory.")
        return

    for s in skills:
        typer.echo(f"  {s.capability_string()}")
        typer.echo(f"    Description: {s.description}")
        if s.params:
            typer.echo(f"    Params: {', '.join(p.name for p in s.params)}")
        typer.echo(f"    Timeout: {s.timeout}s")
        if s.path:
            typer.echo(f"    File: {s.path}")
        typer.echo()


@skills_app.command("import", help="Import a skill YAML file into the skills directory")
def cli_skills_import(
    file: Path = typer.Argument(..., help="Path to skill YAML file to import"),
):
    from .skills import load_skill, _find_skills_dir
    import shutil

    if not file.is_file():
        typer.echo(f"Error: File not found: {file}")
        raise typer.Exit(code=1)

    # Validate first
    try:
        skill = load_skill(file)
    except Exception as e:
        typer.echo(f"Error: Invalid skill file: {e}")
        raise typer.Exit(code=1)

    skills_dir = _find_skills_dir()
    skills_dir.mkdir(parents=True, exist_ok=True)

    dest = skills_dir / f"{skill.name}.yaml"
    if dest.exists():
        overwrite = typer.confirm(f"Skill '{skill.name}' already exists. Overwrite?")
        if not overwrite:
            typer.echo("Cancelled.")
            raise typer.Exit(code=0)

    shutil.copy2(file, dest)
    typer.echo(f"Imported skill '{skill.name}' to {dest}")
    typer.echo(f"Capability: {skill.capability_string()}")


@skills_app.command("validate", help="Validate a skill YAML file without importing")
def cli_skills_validate(
    file: Path = typer.Argument(..., help="Path to skill YAML file to validate"),
):
    from .skills import load_skill

    if not file.is_file():
        typer.echo(f"Error: File not found: {file}")
        raise typer.Exit(code=1)

    try:
        skill = load_skill(file)
    except Exception as e:
        typer.echo(f"INVALID: {e}")
        raise typer.Exit(code=1)

    typer.echo(f"VALID: {skill.name}")
    typer.echo(f"  Type: {skill.skill_type}")
    typer.echo(f"  Capability: {skill.capability_string()}")
    typer.echo(f"  Description: {skill.description}")
    if skill.params:
        for p in skill.params:
            default_str = f" (default: {p.default})" if p.default is not None else " (required)"
            typer.echo(f"  Param: {p.name} [{p.type}]{default_str}")
    typer.echo(f"  Timeout: {skill.timeout}s")
    if skill.skill_type == "shell" and skill.script:
        typer.echo(f"  Script: {len(skill.script)} chars")
    elif skill.skill_type == "llm":
        typer.echo(f"  Model: {skill.model}")
        if skill.system:
            typer.echo(f"  System: {skill.system[:60]}{'...' if len(skill.system) > 60 else ''}")
        if skill.prompt:
            typer.echo(f"  Prompt: {len(skill.prompt)} chars")


@skills_app.command("export", help="Export a skill to YAML on stdout")
def cli_skills_export(
    name: str = typer.Argument(..., help="Skill name to export"),
):
    from .skills import get_skill_by_capability

    skill = get_skill_by_capability(f"skill.{name}")
    if not skill:
        typer.echo(f"Error: Skill '{name}' not found")
        raise typer.Exit(code=1)

    if skill.path and skill.path.is_file():
        typer.echo(skill.path.read_text(encoding="utf-8"))
    else:
        typer.echo(f"Error: Skill file not found on disk")
        raise typer.Exit(code=1)
