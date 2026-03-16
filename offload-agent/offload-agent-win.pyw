#!/usr/bin/env python3
"""
Windows GUI entrypoint for Offload Agent.

Launches the web UI without a console window, opens the browser automatically,
and places a system-tray icon with Open / Quit actions.
Used as the PyInstaller entrypoint for the Windows .exe build (--windowed).
"""

import atexit
import os
import signal
import sys
import threading
import webbrowser

# ── Fix headless streams ───────────────────────────────────────────────────────
# PyInstaller --windowed sets stdout/stderr to None (no console).
# Uvicorn and other libs expect writable streams with .isatty(), so redirect
# to os.devnull before any imports that touch logging.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

# ── Bootstrap ──────────────────────────────────────────────────────────────────
# When frozen by PyInstaller --onefile, code/data live in a temp dir (_MEIPASS)
# but config files must be next to the .exe so they persist across runs.
if getattr(sys, "frozen", False):
    _MEIPASS = sys._MEIPASS
    EXE_DIR = os.path.dirname(sys.executable)
    sys.path.insert(0, _MEIPASS)
    os.chdir(EXE_DIR)
else:
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
    os.chdir(SCRIPT_DIR)
    sys.path.insert(0, SCRIPT_DIR)

HOST = "127.0.0.1"
PORT = 8080
URL = f"http://{HOST}:{PORT}"


# ── Tray icon ─────────────────────────────────────────────────────────────────

def _create_tray_icon() -> None:
    """Build a 64x64 icon in memory and show a pystray system-tray icon."""
    from pystray import Icon, Menu, MenuItem
    from PIL import Image, ImageDraw

    # Draw a simple coloured square with an "O" letter
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
    icon.run()  # blocks until icon.stop()


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    import webui
    from webui import app as fastapi_app, stop_agent
    import uvicorn

    # Honor autostart config
    from app.config import load_config
    cfg = load_config()
    if cfg.get("autostart"):
        webui._autostart = True

    atexit.register(stop_agent)

    # Open browser after a short delay to let uvicorn bind
    def _open_browser():
        import time
        time.sleep(1.5)
        webbrowser.open(URL)

    threading.Thread(target=_open_browser, daemon=True).start()

    # System tray icon (runs its own message loop in a daemon thread)
    threading.Thread(target=_create_tray_icon, daemon=True).start()

    uvicorn.run(fastapi_app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
