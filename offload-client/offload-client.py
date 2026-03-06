#!/usr/bin/env python3
"""
Offload Client

Usage:
  offload-client webui [--host HOST] [--port PORT]
  offload-client cli <command> [options]
  offload-client install bin [--dest DIR]
  offload-client install systemd [--bin-path PATH] [--user USER] [--host HOST] [--port PORT]
  offload-client --help
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

    parser = argparse.ArgumentParser(prog="offload-client install bin")
    parser.add_argument("--dest", default="/usr/local/bin",
                        help="Directory to install the binary into (default: /usr/local/bin)")
    args = parser.parse_args(argv)

    src = _this_binary()
    dest_dir = args.dest
    dest = os.path.join(dest_dir, "offload-client")

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

    parser = argparse.ArgumentParser(prog="offload-client install systemd")
    parser.add_argument("--bin-path", default="/usr/local/bin/offload-client",
                        help="Path to the installed binary (default: /usr/local/bin/offload-client)")
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
        print(f"Run 'offload-client install bin' first.")
        sys.exit(1)

    service_name = "offload-client"
    service_path = f"/etc/systemd/system/{service_name}.service"

    unit = f"""\
[Unit]
Description=Offload Client Agent (Web UI)
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


# ── dispatcher ─────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        sys.exit(0)

    cmd = sys.argv[1]

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

        parser = argparse.ArgumentParser(prog="offload-client webui")
        parser.add_argument("--host", default="0.0.0.0")
        parser.add_argument("--port", type=int, default=8080)
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
        print(f"Starting Offload Client Web UI on http://{args.host}:{args.port}")
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
        else:
            print(f"Usage: offload-client install {{bin|systemd}} [options]")
            sys.exit(1)

    else:
        print(f"Unknown command: {cmd!r}\n")
        print(__doc__.strip())
        sys.exit(1)


if __name__ == "__main__":
    main()
