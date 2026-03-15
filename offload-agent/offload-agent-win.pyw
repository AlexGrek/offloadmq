#!/usr/bin/env python3
"""
Windows GUI entrypoint for Offload Agent.

Launches the web UI without a console window and opens the browser automatically.
Used as the PyInstaller entrypoint for the Windows .exe build (--windowed).
"""

import atexit
import os
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
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)


def main():
    import webui
    from webui import app as fastapi_app, stop_agent
    import uvicorn

    host = "127.0.0.1"
    port = 8080

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
        webbrowser.open(f"http://{host}:{port}")

    threading.Thread(target=_open_browser, daemon=True).start()

    uvicorn.run(fastapi_app, host=host, port=port)


if __name__ == "__main__":
    main()
