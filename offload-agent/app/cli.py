import typer
import requests
from pathlib import Path
from typing import Optional, List
from .ollama import *
from .config import *
from .systeminfo import *
from .models import *
from .httphelpers import *
from .core import serve_tasks
from .exec.slavemode import merge_registration_caps, strip_slavemode_caps


app = typer.Typer(add_completion=False, no_args_is_help=True, help="Offload Agent CLI")
custom_app = typer.Typer(help="Manage custom capabilities")
app.add_typer(custom_app, name="custom")
slavemode_app = typer.Typer(help="Manage slavemode capability permissions")
app.add_typer(slavemode_app, name="slavemode")
onnx_app = typer.Typer(help="Manage ONNX models (download, list, delete)")
app.add_typer(onnx_app, name="onnx")


@app.command("sysinfo", help="Display system information")
def cli_sysinfo() -> None:
    print_system_info(collect_system_info())


@app.command("ollama", help="Display detected Ollama models")
def cli_ollama() -> None:
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
    tier: Optional[int] = typer.Option(None, help="Performance tier (0-255). Auto-detected if not specified."),
    caps: List[str] = typer.Option(
        ["debug.echo", "shell.bash", "shellcmd.bash", "tts.kokoro"], help="Agent capabilities"
    ),
    capacity: int = typer.Option(1, help="Concurrent task capacity"),
) -> None:
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

    if tier is None:
        tier = calculate_tier(sysinfo)
        typer.echo(f"Auto-detected tier: {tier}")

    ollama_models = get_ollama_models()
    combined_caps = sorted(set(strip_slavemode_caps(list(caps)) + ollama_models))
    combined_caps = merge_registration_caps(combined_caps, cfg)

    typer.echo(f"\nRegistering with server: {server}")
    typer.echo(f"Capabilities: {combined_caps}")

    display_name: Optional[str] = cfg.get("displayName") or None

    try:
        reg = register_agent(server, combined_caps, tier, capacity, api_key, display_name=display_name)
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
) -> None:
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

    # Determine transport: --ws flag overrides config
    transport_type: str = "websocket" if ws else cfg.get("transport", "websocket")
    typer.echo(f"Starting task loop (transport={transport_type})...")
    serve_tasks(server, jwt, transport_type=transport_type)


@custom_app.command("list", help="List all discovered custom capabilities")
def cli_custom_list() -> None:
    from .custom_caps import discover_custom_caps, _find_custom_caps_dir

    caps_dir = _find_custom_caps_dir()
    typer.echo(f"Custom caps directory: {caps_dir}\n")

    caps = discover_custom_caps()
    if not caps:
        typer.echo("No custom caps found. Create .yaml files in the caps directory.")
        return

    for c in caps:
        typer.echo(f"  {c.capability_string()}")
        typer.echo(f"    Description: {c.description}")
        if c.params:
            typer.echo(f"    Params: {', '.join(p.name for p in c.params)}")
        typer.echo(f"    Timeout: {c.timeout}s")
        if c.path:
            typer.echo(f"    File: {c.path}")
        typer.echo()


@custom_app.command("import", help="Import a custom capability YAML file")
def cli_custom_import(
    file: Path = typer.Argument(..., help="Path to custom capability YAML file to import"),
) -> None:
    from .custom_caps import load_custom_cap, _find_custom_caps_dir
    import shutil

    if not file.is_file():
        typer.echo(f"Error: File not found: {file}")
        raise typer.Exit(code=1)

    # Validate first
    try:
        cap = load_custom_cap(file)
    except Exception as e:
        typer.echo(f"Error: Invalid custom cap file: {e}")
        raise typer.Exit(code=1)

    caps_dir = _find_custom_caps_dir()
    caps_dir.mkdir(parents=True, exist_ok=True)

    dest = caps_dir / f"{cap.name}.yaml"
    if dest.exists():
        overwrite = typer.confirm(f"Custom cap '{cap.name}' already exists. Overwrite?")
        if not overwrite:
            typer.echo("Cancelled.")
            raise typer.Exit(code=0)

    shutil.copy2(file, dest)
    typer.echo(f"Imported custom cap '{cap.name}' to {dest}")
    typer.echo(f"Capability: {cap.capability_string()}")


@custom_app.command("validate", help="Validate a custom capability YAML file without importing")
def cli_custom_validate(
    file: Path = typer.Argument(..., help="Path to custom capability YAML file to validate"),
) -> None:
    from .custom_caps import load_custom_cap

    if not file.is_file():
        typer.echo(f"Error: File not found: {file}")
        raise typer.Exit(code=1)

    try:
        cap = load_custom_cap(file)
    except Exception as e:
        typer.echo(f"INVALID: {e}")
        raise typer.Exit(code=1)

    typer.echo(f"VALID: {cap.name}")
    typer.echo(f"  Type: {cap.exec_type}")
    typer.echo(f"  Capability: {cap.capability_string()}")
    typer.echo(f"  Description: {cap.description}")
    if cap.params:
        for p in cap.params:
            default_str = f" (default: {p.default})" if p.default is not None else " (required)"
            typer.echo(f"  Param: {p.name} [{p.type}]{default_str}")
    typer.echo(f"  Timeout: {cap.timeout}s")
    if cap.exec_type == "shell" and cap.script:
        typer.echo(f"  Script: {len(cap.script)} chars")
    elif cap.exec_type == "llm":
        typer.echo(f"  Model: {cap.model}")
        if cap.system:
            typer.echo(f"  System: {cap.system[:60]}{'...' if len(cap.system) > 60 else ''}")
        if cap.prompt:
            typer.echo(f"  Prompt: {len(cap.prompt)} chars")


@custom_app.command("export", help="Export a custom capability to YAML on stdout")
def cli_custom_export(
    name: str = typer.Argument(..., help="Custom cap name to export"),
) -> None:
    from .custom_caps import get_custom_cap

    cap = get_custom_cap(f"custom.{name}")
    if not cap:
        typer.echo(f"Error: Custom cap '{name}' not found")
        raise typer.Exit(code=1)

    if cap.path and cap.path.is_file():
        typer.echo(cap.path.read_text(encoding="utf-8"))
    else:
        typer.echo(f"Error: Custom cap file not found on disk")
        raise typer.Exit(code=1)


@slavemode_app.command("status", help="Show which slavemode capabilities are currently allowed")
def cli_slavemode_status() -> None:
    from .exec.slavemode import ALL_SLAVEMODE_CAPS, CONFIG_KEY

    cfg = load_config()
    allowed: list[str] = cfg.get(CONFIG_KEY) or []

    typer.echo(f"Config key: {CONFIG_KEY}\n")
    for cap in ALL_SLAVEMODE_CAPS:
        mark = "✅" if cap in allowed else "❌"
        typer.echo(f"  {mark} {cap}")

    if not allowed:
        typer.echo(f"\nNo slavemode capabilities are allowed. Run 'slavemode allow-all' to enable them.")


@slavemode_app.command("allow-all", help="Allow all slavemode capabilities by adding them to the config allow-list")
def cli_slavemode_allow_all() -> None:
    from .exec.slavemode import ALL_SLAVEMODE_CAPS, CONFIG_KEY

    cfg = load_config()
    existing: list[str] = cfg.get(CONFIG_KEY) or []
    added = [cap for cap in ALL_SLAVEMODE_CAPS if cap not in existing]

    cfg[CONFIG_KEY] = sorted(set(existing + ALL_SLAVEMODE_CAPS))
    save_config(cfg)

    if added:
        typer.echo(f"Added {len(added)} cap(s) to '{CONFIG_KEY}':")
        for cap in added:
            typer.echo(f"  + {cap}")
    else:
        typer.echo(f"All slavemode capabilities were already in '{CONFIG_KEY}'. Nothing changed.")


@slavemode_app.command("deny-all", help="Remove all slavemode capabilities from the config allow-list")
def cli_slavemode_deny_all() -> None:
    from .exec.slavemode import CONFIG_KEY

    cfg = load_config()
    if not cfg.get(CONFIG_KEY):
        typer.echo("Allow-list is already empty. Nothing changed.")
        return

    cfg[CONFIG_KEY] = []
    save_config(cfg)
    typer.echo(f"Cleared '{CONFIG_KEY}'. All slavemode capabilities are now disabled.")


@slavemode_app.command("allow", help="Allow a specific slavemode capability")
def cli_slavemode_allow(
    cap: str = typer.Argument(..., help="Capability to allow (e.g. slavemode.force-rescan)"),
) -> None:
    from .exec.slavemode import ALL_SLAVEMODE_CAPS, CONFIG_KEY

    if cap not in ALL_SLAVEMODE_CAPS:
        typer.echo(f"Error: Unknown slavemode capability '{cap}'.")
        typer.echo(f"Available: {', '.join(ALL_SLAVEMODE_CAPS)}")
        raise typer.Exit(code=1)

    cfg = load_config()
    existing: list[str] = cfg.get(CONFIG_KEY) or []
    if cap in existing:
        typer.echo(f"'{cap}' is already allowed.")
        return

    existing.append(cap)
    cfg[CONFIG_KEY] = sorted(set(existing))
    save_config(cfg)
    typer.echo(f"Allowed '{cap}'.")


@slavemode_app.command("deny", help="Deny a specific slavemode capability")
def cli_slavemode_deny(
    cap: str = typer.Argument(..., help="Capability to deny (e.g. slavemode.force-rescan)"),
) -> None:
    from .exec.slavemode import ALL_SLAVEMODE_CAPS, CONFIG_KEY

    if cap not in ALL_SLAVEMODE_CAPS:
        typer.echo(f"Error: Unknown slavemode capability '{cap}'.")
        typer.echo(f"Available: {', '.join(ALL_SLAVEMODE_CAPS)}")
        raise typer.Exit(code=1)

    cfg = load_config()
    existing: list[str] = cfg.get(CONFIG_KEY) or []
    if cap not in existing:
        typer.echo(f"'{cap}' is already denied.")
        return

    existing.remove(cap)
    cfg[CONFIG_KEY] = sorted(set(existing))
    save_config(cfg)
    typer.echo(f"Denied '{cap}'.")


# ---------------------------------------------------------------------------
# ONNX model management
# ---------------------------------------------------------------------------

@onnx_app.command("list", help="List known ONNX models and their download status")
def cli_onnx_list() -> None:
    from .onnx_models import list_models, models_dir

    typer.echo(f"Models directory: {models_dir()}\n")
    models = list_models()
    if not models:
        typer.echo("No known ONNX models in registry.")
        return

    for m in models:
        status = "✅ installed" if m["installed"] else "❌ not downloaded"
        typer.echo(f"  {m['name']} ({m['capability']})")
        typer.echo(f"    {m['description']}")
        typer.echo(f"    Status: {status}")
        if m.get("size_bytes"):
            mb = m["size_bytes"] / (1024 * 1024)
            typer.echo(f"    Size: {mb:.1f} MB")
            typer.echo(f"    Path: {m['path']}")
        typer.echo()


@onnx_app.command("prepare", help="Download an ONNX model")
def cli_onnx_prepare(
    name: str = typer.Argument(..., help="Model name to download (e.g. 'nudenet')"),
) -> None:
    from .onnx_models import prepare_model

    def on_progress(status: str) -> None:
        typer.echo(status)

    try:
        path = prepare_model(name, on_progress)
    except RuntimeError as e:
        typer.echo(f"Error: {e}")
        raise typer.Exit(code=1)

    typer.echo(f"\n✅ Model '{name}' ready at {path}")


@onnx_app.command("delete", help="Delete a downloaded ONNX model")
def cli_onnx_delete(
    name: str = typer.Argument(..., help="Model name to delete (e.g. 'nudenet')"),
) -> None:
    from .onnx_models import delete_model

    if delete_model(name):
        typer.echo(f"Deleted ONNX model '{name}'.")
    else:
        typer.echo(f"ONNX model '{name}' is not installed or unknown.")
        raise typer.Exit(code=1)


@onnx_app.command("enable", help="Download model(s) and enable ONNX + slavemode capabilities")
def cli_onnx_enable(
    name: str = typer.Argument("nudenet", help="Model name to prepare (default: nudenet)"),
) -> None:
    from .onnx_models import prepare_model, ONNX_MODEL_REGISTRY
    from .exec.slavemode import CONFIG_KEY

    if name not in ONNX_MODEL_REGISTRY:
        known = ", ".join(ONNX_MODEL_REGISTRY)
        typer.echo(f"Error: Unknown model '{name}'. Known: {known}")
        raise typer.Exit(code=1)

    typer.echo(f"Preparing ONNX model '{name}'...")

    def on_progress(status: str) -> None:
        typer.echo(f"  {status}")

    try:
        path = prepare_model(name, on_progress)
    except RuntimeError as e:
        typer.echo(f"Error: {e}")
        raise typer.Exit(code=1)

    typer.echo(f"✅ Model ready at {path}\n")

    onnx_slavemode = [
        "slavemode.onnx-models-delete",
        "slavemode.onnx-models-list",
        "slavemode.onnx-models-prepare",
    ]

    cfg = load_config()
    existing: list[str] = cfg.get(CONFIG_KEY) or []
    added = [c for c in onnx_slavemode if c not in existing]

    if added:
        cfg[CONFIG_KEY] = sorted(set(existing + onnx_slavemode))
        save_config(cfg)
        typer.echo(f"Enabled {len(added)} ONNX slavemode cap(s):")
        for cap in added:
            typer.echo(f"  + {cap}")
    else:
        typer.echo("ONNX slavemode capabilities were already enabled.")

    typer.echo(f"\nONNX capability '{ONNX_MODEL_REGISTRY[name]['capability']}' is now available.")
