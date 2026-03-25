#!/usr/bin/env python3
"""
Offload Agent

Usage:
  offload-agent webui [--host HOST] [--port PORT]
  offload-agent cli <command> [options]
  offload-agent install bin [--dest DIR]
  offload-agent install systemd [--bin-path PATH] [--user USER] [--host HOST] [--port PORT]
  offload-agent install launchd [--app-path PATH]
  offload-agent --version
  offload-agent --help
"""

import sys


# ── helpers ────────────────────────────────────────────────────────────────────

def _this_binary() -> str:
    """Return path to the running executable (frozen bundle or script)."""
    import os
    if getattr(sys, "frozen", False):
        return sys.executable
    # running as a plain .py — use the script file itself
    return os.path.abspath(__file__)


def _cmd_install_bin(argv: list[str]) -> None:
    import argparse, os, shutil, stat

    parser = argparse.ArgumentParser(prog="offload-agent install bin")
    parser.add_argument("--dest", default="/usr/local/bin",
                        help="Directory to install the binary into (default: /usr/local/bin)")
    args = parser.parse_args(argv)

    src = _this_binary()
    dest_dir = args.dest
    dest = os.path.join(dest_dir, "offload-agent")

    try:
        os.makedirs(dest_dir, exist_ok=True)
        shutil.copy2(src, dest)
        # rwxr-xr-x
        os.chmod(dest, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        print(f"Installed: {dest}")
    except PermissionError:
        print(f"Error: permission denied writing to {dest_dir}. Re-run with sudo.")
        sys.exit(1)


def _cmd_install_systemd(argv: list[str]) -> None:
    import argparse, getpass, os

    parser = argparse.ArgumentParser(prog="offload-agent install systemd")
    parser.add_argument("--bin-path", default="/usr/local/bin/offload-agent",
                        help="Path to the installed binary (default: /usr/local/bin/offload-agent)")
    parser.add_argument("--user", default=getpass.getuser(),
                        help="System user to run the service as (default: current user)")
    parser.add_argument("--host", default="0.0.0.0",
                        help="Web UI bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8080,
                        help="Web UI port (default: 8080)")
    args = parser.parse_args(argv)

    if sys.platform != "linux":
        print(f"Error: systemd installation is only supported on Linux (current platform: {sys.platform}).")
        sys.exit(1)

    if not os.path.isfile(args.bin_path):
        print(f"Error: binary not found at {args.bin_path!r}.")
        print(f"Run 'offload-agent install bin' first.")
        sys.exit(1)

    service_name = "offload-agent"
    service_path = f"/etc/systemd/system/{service_name}.service"

    unit = f"""\
[Unit]
Description=Offload Agent (Web UI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={args.user}
ExecStartPre=/bin/sleep 30
ExecStart={args.bin_path} webui --host {args.host} --port {args.port} --agent-autostart
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
"""

    try:
        os.makedirs(os.path.dirname(service_path), exist_ok=True)
        with open(service_path, "w") as f:
            f.write(unit)
        print(f"Wrote:    {service_path}")
    except PermissionError:
        print(f"Error: permission denied writing to {service_path}. Re-run with sudo.")
        sys.exit(1)

    print("Enabling and starting service…")
    os.system(f"systemctl daemon-reload")
    os.system(f"systemctl enable {service_name}")
    os.system(f"systemctl start  {service_name}")
    print(f"\nDone. Check status with:  systemctl status {service_name}")


def _cmd_install_launchd(argv: list[str]) -> None:
    import argparse, os, subprocess

    parser = argparse.ArgumentParser(prog="offload-agent install launchd")
    parser.add_argument(
        "--app-path",
        default=None,
        help="Path to Offload Agent.app (default: auto-detected from running executable)",
    )
    args = parser.parse_args(argv)

    if sys.platform != "darwin":
        print(f"Error: launchd installation is only supported on macOS (current platform: {sys.platform}).")
        sys.exit(1)

    if args.app_path:
        exe_path = args.app_path
    elif getattr(sys, "frozen", False):
        # Running inside the .app bundle — sys.executable is the binary inside MacOS/
        exe_path = sys.executable
    else:
        print("Error: --app-path required when not running from a frozen .app bundle.")
        sys.exit(1)

    label = "com.offloadmq.agent"
    plist_path = os.path.expanduser(f"~/Library/LaunchAgents/{label}.plist")
    plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe_path}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
"""
    os.makedirs(os.path.dirname(plist_path), exist_ok=True)
    with open(plist_path, "w") as f:
        f.write(plist)
    print(f"Wrote: {plist_path}")

    subprocess.run(["launchctl", "load", plist_path])
    print(f"\nDone. The agent will launch at login.")
    print(f"To remove: launchctl unload {plist_path} && rm {plist_path}")


# ── dispatcher ─────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        sys.exit(0)

    cmd = sys.argv[1]

    if cmd in ("-V", "--version"):
        try:
            from app._version import APP_VERSION
        except ImportError:
            APP_VERSION = "dev"
        print(APP_VERSION)
        sys.exit(0)

    if cmd == "webui":
        import argparse, atexit
        try:
            import webui
            from webui import app as fastapi_app, stop_agent
            import uvicorn
        except ImportError as e:
            print(f"Error: webui dependencies not installed ({e}).")
            print("Install them with: pip install fastapi uvicorn[standard] python-multipart")
            sys.exit(1)

        from app.config import load_config
        _cfg = load_config()
        _default_port = _cfg.get("webuiPort", 8080)

        parser = argparse.ArgumentParser(prog="offload-agent webui")
        parser.add_argument("--host", default="0.0.0.0")
        parser.add_argument("--port", type=int, default=_default_port)
        parser.add_argument("--agent-autostart", action="store_true",
                            help="Honor the autostart config setting (always passed by the systemd service)")
        parser.add_argument("--agent-autostart-enable", action="store_true",
                            help="Persist autostart=true to config and start the agent immediately")
        args = parser.parse_args(sys.argv[2:])

        if args.agent_autostart_enable:
            from app.config import load_config, save_config
            cfg = load_config()
            cfg["autostart"] = True
            save_config(cfg)
            webui._autostart = True
        elif args.agent_autostart:
            webui._autostart = True

        atexit.register(stop_agent)
        print(f"Starting Offload Agent Web UI on http://{args.host}:{args.port}")
        uvicorn.run(fastapi_app, host=args.host, port=args.port)

    elif cmd == "cli":
        from app.cli import app
        sys.argv = [sys.argv[0]] + sys.argv[2:]
        app()

    elif cmd == "install":
        sub = sys.argv[2] if len(sys.argv) > 2 else ""
        if sub == "bin":
            _cmd_install_bin(sys.argv[3:])
        elif sub == "systemd":
            _cmd_install_systemd(sys.argv[3:])
        elif sub == "launchd":
            _cmd_install_launchd(sys.argv[3:])
        else:
            print(f"Usage: offload-agent install {{bin|systemd|launchd}} [options]")
            sys.exit(1)

    else:
        print(f"Unknown command: {cmd!r}\n")
        print(__doc__.strip())
        sys.exit(1)


if __name__ == "__main__":
    main()
