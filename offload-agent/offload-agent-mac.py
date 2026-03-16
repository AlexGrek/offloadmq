#!/usr/bin/env python3
"""
macOS GUI entry point for Offload Agent.

Runs the web UI in a background thread and shows a menu-bar (tray) icon
using pystray. On macOS pystray must run on the main thread (Cocoa requirement),
so uvicorn runs in a daemon thread instead.

Used as the PyInstaller entry point for the macOS .app bundle (--windowed).
"""

import atexit
import os
import signal
import sys
import threading
import webbrowser

# ── Fix headless streams ───────────────────────────────────────────────────────
# PyInstaller --windowed sets stdout/stderr to None (no console).
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

# ── Bootstrap ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)

HOST = "127.0.0.1"
PORT = 8080
URL = f"http://{HOST}:{PORT}"


# ── Web UI thread ──────────────────────────────────────────────────────────────

def _run_webui() -> None:
    """Start uvicorn in a background thread (main thread is reserved for Cocoa)."""
    import webui
    from webui import app as fastapi_app, stop_agent
    import uvicorn

    from app.config import load_config
    cfg = load_config()
    if cfg.get("autostart"):
        webui._autostart = True

    atexit.register(stop_agent)
    uvicorn.run(fastapi_app, host=HOST, port=PORT)


# ── Tray icon (must run on main thread on macOS) ───────────────────────────────

def _create_tray_icon() -> None:
    """Build a 64x64 icon in memory and show a pystray menu-bar icon."""
    from pystray import Icon, Menu, MenuItem
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (64, 64), "#6366f1")
    draw = ImageDraw.Draw(img)
    draw.ellipse((14, 14, 50, 50), outline="white", width=4)

    def on_open(icon, item):
        webbrowser.open(URL)

    def on_quit(icon, item):
        icon.stop()
        os.kill(os.getpid(), signal.SIGINT)

    icon = Icon(
        "offload-agent",
        img,
        "Offload Agent",
        menu=Menu(
            MenuItem("Open in browser", on_open, default=True),
            MenuItem("Quit", on_quit),
        ),
    )
    icon.run()  # blocks on main thread — required on macOS


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    # Start web server in background
    threading.Thread(target=_run_webui, daemon=True).start()

    # Open browser after a short delay to let uvicorn bind
    def _open_browser():
        import time
        time.sleep(1.5)
        webbrowser.open(URL)

    threading.Thread(target=_open_browser, daemon=True).start()

    # Tray icon on main thread (Cocoa requirement)
    _create_tray_icon()


if __name__ == "__main__":
    main()
