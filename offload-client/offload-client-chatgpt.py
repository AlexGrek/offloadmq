#!/usr/bin/env python3
"""
Offload Client (refactored)

- Pydantic models instead of dataclasses
- Consistent URL-quoting for ALL path parts (IDs, caps, etc.)
- Shared helpers for HTTP + task result reporting (no duplication)
- Typer-based CLI (single file, logical sections)
- Implements previously missing pieces (e.g., get_gpu_info)
"""

# =========================
# Imports & Constants
# =========================

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import psutil
import requests
import typer
from pydantic import BaseModel, Field, validator
from urllib.parse import quote

app = typer.Typer(help="Offload client CLI")

CONFIG_FILE = ".offload-client.json"
OLLAMA_BASE = "http://127.0.0.1:11434"
OLLAMA_CHAT = f"{OLLAMA_BASE}/api/chat"
DEFAULT_POLL_SLEEP_SEC = 5
HTTP_TIMEOUT = 60


# =========================
# Utilities (Quoting, HTTP, Config, System)
# =========================

def q(part: str) -> str:
    """Quote a URL path segment safely (no slashes allowed to leak)."""
    return quote(str(part), safe="")

def join_url(base: str, *parts: str) -> str:
    base = base.rstrip("/")
    return "/".join([base] + [q(p) for p in parts])

def http_post_json(url: str, payload: Dict[str, Any], headers: Optional[Dict[str, str]] = None, timeout: int = HTTP_TIMEOUT) -> requests.Response:
    r = requests.post(url, json=payload, headers=headers or {}, timeout=timeout)
    r.raise_for_status()
    return r

def http_get_json(url: str, headers: Optional[Dict[str, str]] = None, timeout: int = HTTP_TIMEOUT) -> Dict[str, Any]:
    r = requests.get(url, headers=headers or {}, timeout=timeout)
    r.raise_for_status()
    return r.json()

def load_config() -> Dict[str, Any]:
    path = Path(CONFIG_FILE)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception as e:
        print(f"Warning: Could not load config ({e}). Using empty config.")
        return {}

def save_config(cfg: Dict[str, Any]) -> None:
    try:
        Path(CONFIG_FILE).write_text(json.dumps(cfg, indent=2))
    except Exception as e:
        print(f"Error: Could not save config: {e}")
        sys.exit(1)

def is_ollama_server_running() -> bool:
    try:
        r = requests.get(OLLAMA_BASE + "/", timeout=1)
        return (r.status_code == 200) and ("Ollama is running" in r.text)
    except requests.exceptions.RequestException:
        return False

def start_ollama_server() -> bool:
    print("Ollama server not found. Attempting to start 'ollama serve'...")
    try:
        subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("'ollama serve' command issued. Waiting for server to initialize...")
        for _ in range(10):
            time.sleep(1)
            if is_ollama_server_running():
                print("✅ Ollama server started successfully.")
                return True
        print("❌ Failed to detect Ollama server after issuing start command.")
        return False
    except FileNotFoundError:
        print("Error: 'ollama' command not found. Please ensure it’s installed and on PATH.")
        return False
    except Exception as e:
        print(f"Unexpected error starting Ollama: {e}")
        return False

def get_ollama_models() -> List[str]:
    """Discover local Ollama models as LLM capabilities."""
    try:
        subprocess.run(["ollama", "--version"], check=True, capture_output=True)
        out = subprocess.run(["ollama", "list"], check=True, capture_output=True, text=True)
        lines = [ln.strip() for ln in out.stdout.strip().splitlines()]
        if len(lines) < 2:
            return []
        models: List[str] = []
        for line in lines[1:]:
            parts = line.split()
            if not parts:
                continue
            name = parts[0]
            if name.endswith(":latest"):
                name = name[:-7]
            models.append(f"LLM::{name}")
        return models
    except FileNotFoundError:
        print("Warning: Ollama not installed; no LLM capabilities will be added.")
    except subprocess.CalledProcessError as e:
        msg = e.stderr.decode("utf-8", errors="ignore") if isinstance(e.stderr, bytes) else (e.stderr or "")
        print(f"Warning: 'ollama list' failed: {msg.strip()}")
    except Exception as e:
        print(f"Warning: Ollama discovery error: {e}")
    return []

def _gpu_info_windows() -> Optional[Dict[str, Any]]:
    try:
        out = subprocess.check_output(["wmic", "path", "win32_videocontroller", "get", "name,adapterram"], text=True)
        lines = [l.strip() for l in out.strip().splitlines() if l.strip()]
        if len(lines) >= 2:
            # Skip header
            best = lines[1]
            # "Name  AdapterRAM"
            parts = best.split()
            # Crude parse: join all but last as name, last as bytes
            try:
                vram_bytes = int(parts[-1])
                name = " ".join(parts[:-1])
            except Exception:
                name = best
                vram_bytes = 0
            return {"vendor": "Unknown", "model": name, "vramMb": vram_bytes // (1024 * 1024)}
    except Exception:
        pass
    return None

def _gpu_info_nvidia() -> Optional[Dict[str, Any]]:
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
        line = out.strip().splitlines()[0]
        name, mem = [p.strip() for p in line.split(",")]
        return {"vendor": "NVIDIA", "model": name, "vramMb": int(mem)}
    except Exception:
        return None

def _gpu_info_amd() -> Optional[Dict[str, Any]]:
    # Try rocm-smi if available
    try:
        out = subprocess.check_output(["rocm-smi", "--showproductname", "--showvram"], text=True, stderr=subprocess.DEVNULL)
        # Very rough parse; formats vary widely.
        name = None
        vram_mb = None
        for ln in out.splitlines():
            l = ln.strip()
            if "Card series" in l or "Product" in l:
                name = l.split(":")[-1].strip()
            if "VRAM Total" in l:
                try:
                    v = l.split(":")[-1].strip().split()[0]
                    vram_mb = int(v)
                except Exception:
                    pass
        if name or vram_mb is not None:
            return {"vendor": "AMD", "model": name or "AMD GPU", "vramMb": vram_mb or 0}
    except Exception:
        pass
    return None

def get_gpu_info() -> Optional[Dict[str, Any]]:
    """Best-effort GPU detection across platforms (NVIDIA, AMD, Windows generic)."""
    if platform.system() == "Windows":
        info = _gpu_info_windows()
        if info:
            return info
    # Try vendor-specific on Linux/mac
    n = _gpu_info_nvidia()
    if n:
        return n
    a = _gpu_info_amd()
    if a:
        return a
    return None

def collect_system_info() -> Dict[str, Any]:
    memory_bytes = psutil.virtual_memory().total
    memory_mb = memory_bytes // (1024 * 1024)
    cpu_arch = platform.machine()
    os_name = platform.system()
    return {
        "os": os_name,
        "cpuArch": cpu_arch,
        "totalMemoryMb": memory_mb,
        "gpu": get_gpu_info(),
        "client": "offload-client.py",
        "runtime": "python",
    }

def print_system_info(system_info: Dict[str, Any]) -> None:
    print("Collecting system information...")
    print(f"OS: {system_info['os']}")
    print(f"Architecture: {system_info['cpuArch']}")
    print(f"Memory: {system_info['totalMemoryMb']} MB")
    if system_info["gpu"]:
        gpu = system_info["gpu"]
        print(f"GPU: {gpu.get('vendor','?')} {gpu.get('model','?')} ({gpu.get('vramMb',0)} MB VRAM)")
    else:
        print("GPU: None detected")


# =========================
# Models (Pydantic)
# =========================

class TaskId(BaseModel):
    id: str
    cap: str

    @validator("id", "cap", pre=True)
    def ensure_str(cls, v: Any) -> str:
        return str(v)

    def quoted_parts(self) -> Tuple[str, str]:
        return q(self.cap), q(self.id)

    def to_json(self) -> Dict[str, str]:
        return {"id": self.id, "cap": self.cap}


class TaskResultStatus(BaseModel):
    status: str = Field(regex="^(success|failure|notExecuted)$")
    # For success -> data is timedelta
    # For failure -> data is Tuple[str, timedelta]
    # For notExecuted -> data can be any
    data: Any

    def as_wire(self) -> Dict[str, Any]:
        if self.status == "success":
            assert isinstance(self.data, timedelta)
            return {"success": self.data.total_seconds()}
        if self.status == "failure":
            err, dur = self.data
            assert isinstance(dur, timedelta)
            return {"failure": [str(err), dur.total_seconds()]}
        if self.status == "notExecuted":
            return {"notExecuted": self.data}
        raise ValueError(f"Unknown status: {self.status}")


class TaskResultReport(BaseModel):
    task_id: TaskId
    status: TaskResultStatus
    output: Optional[dict]
    capability: str

    def as_wire(self) -> Dict[str, Any]:
        return {
            "id": self.task_id.to_json(),
            "status": self.status.as_wire(),
            "output": self.output,
            "capability": self.capability,
        }


# =========================
# Server API Helpers
# =========================

def register_agent(server: str, capabilities: List[str], tier: int, capacity: int, api_key: str) -> Dict[str, Any]:
    system_info = collect_system_info()
    registration = {
        "capabilities": capabilities,
        "tier": tier,
        "capacity": capacity,
        "systemInfo": system_info,
        "apiKey": api_key,
    }
    url = join_url(server, "agent", "register")
    try:
        r = http_post_json(url, registration, timeout=30)
        return r.json()
    except requests.exceptions.RequestException as e:
        print(f"Error registering agent: {e}")
        sys.exit(1)

def authenticate_agent(server: str, agent_id: str, key: str) -> Dict[str, Any]:
    url = join_url(server, "agent", "auth")
    try:
        r = http_post_json(url, {"agentId": agent_id, "key": key}, timeout=30)
        return r.json()
    except requests.exceptions.RequestException as e:
        print(f"Error authenticating agent: {e}")
        sys.exit(1)

def test_ping(server: str, jwt_token: str) -> bool:
    url = join_url(server, "private", "agent", "ping")
    try:
        r = requests.get(url, headers={"Authorization": f"Bearer {jwt_token}"}, timeout=30)
        return r.status_code == 200
    except requests.exceptions.RequestException:
        return False

def report_task_result(server_url: str, report: TaskResultReport, headers: Dict[str, str]) -> bool:
    cap_q, id_q = report.task_id.quoted_parts()
    url = join_url(server_url, "private", "agent", "task", "resolve", cap_q, id_q)
    try:
        print(f"Reporting result for task {report.task_id.to_json()}")
        http_post_json(url, report.as_wire(), headers=headers)
        return True
    except requests.exceptions.RequestException as e:
        print(f"Failed to report task result for {report.task_id.to_json()}: {e}")
        return False


# =========================
# Executors
# =========================

def execute_debug_echo(task_id: TaskId, capability: str, payload: dict, server_url: str, headers: Dict[str, str]) -> bool:
    print(f"Executing debug::echo for task {task_id.to_json()} with payload: {payload}")
    report = TaskResultReport(
        task_id=task_id,
        status=TaskResultStatus(status="success", data=timedelta(seconds=12.5)),
        output=payload,
        capability=capability,
    )
    return report_task_result(server_url, report, headers)

def execute_shell_bash(task_id: TaskId, capability: str, payload: dict, server_url: str, headers: Dict[str, str]) -> bool:
    print(f"Executing shell::bash for task {task_id.to_json()} with payload: {payload}")
    command = (payload or {}).get("command")
    if not command:
        error_output = {"error": "No 'command' provided in payload."}
        report = TaskResultReport(
            task_id=task_id,
            status=TaskResultStatus(status="failure", data=("Missing command", timedelta(seconds=12.5))),
            output=error_output,
            capability=capability,
        )
        return report_task_result(server_url, report, headers)

    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, check=True)
        report = TaskResultReport(
            task_id=task_id,
            status=TaskResultStatus(status="success", data=timedelta(seconds=12.5)),
            output={"stdout": result.stdout, "stderr": result.stderr},
            capability=capability,
        )
    except subprocess.CalledProcessError as e:
        report = TaskResultReport(
            task_id=task_id,
            status=TaskResultStatus(status="failure", data=(e.stderr or f"Return code {e.returncode}", timedelta(seconds=5.0))),
            output={"stdout": e.stdout, "stderr": e.stderr, "return_code": e.returncode},
            capability=capability,
        )
    except Exception as e:
        report = TaskResultReport(
            task_id=task_id,
            status=TaskResultStatus(status="failure", data=(str(e), timedelta(seconds=5.0))),
            output={"error": str(e)},
            capability=capability,
        )
    return report_task_result(server_url, report, headers)

def execute_llm_query(task_id: TaskId, capability: str, payload: dict, server_url: str, headers: Dict[str, str]) -> bool:
    """
    Handles LLM tasks by sending a query to the local Ollama REST API.
    capability format: 'LLM::<model-name>'
    payload is passed through to Ollama's /api/chat (allows messages or prompt formats).
    """
    try:
        model_name = capability.split("::", 1)[-1]
        if not model_name:
            raise ValueError("LLM capability missing model name (expected 'LLM::<model>').")

        # Be permissive: if payload is a string, wrap as a simple prompt.
        # If it's a dict, pass through (user may send full chat payload already).
        if isinstance(payload, str):
            api_payload = {"model": model_name, "prompt": payload, "stream": False}
        elif isinstance(payload, dict):
            # ensure model is set; don't clobber user's structure if they provided messages
            api_payload = {"model": model_name, **payload}
            api_payload.setdefault("stream", False)
        else:
            raise ValueError("Invalid LLM payload: expected string or dict.")

        print(f"Executing LLM query for task {task_id.to_json()} with model '{model_name}'.")
        r = requests.post(OLLAMA_CHAT, json=api_payload, timeout=300)
        r.raise_for_status()
        out = r.json()

        report = TaskResultReport(
            task_id=task_id,
            status=TaskResultStatus(status="success", data=timedelta(seconds=12.5)),
            output=out,
            capability=capability,
        )
    except requests.exceptions.RequestException as e:
        detail = e.response.text if getattr(e, "response", None) is not None else "No response"
        report = TaskResultReport(
            task_id=task_id,
            status=TaskResultStatus(status="failure", data=(f"Ollama API request failed: {e}", timedelta(seconds=5.0))),
            output={"error": "Ollama API request failed", "response_text": detail},
            capability=capability,
        )
    except Exception as e:
        report = TaskResultReport(
            task_id=task_id,
            status=TaskResultStatus(status="failure", data=(str(e), timedelta(seconds=5.0))),
            output={"error": str(e)},
            capability=capability,
        )

    return report_task_result(server_url, report, headers)


# =========================
# Task Serving Loop
# =========================

def parse_task_id(d: Dict[str, str]) -> TaskId:
    # Ensure incoming IDs are preserved for JSON but we will quote them for URLs when needed
    return TaskId(id=str(d["id"]), cap=str(d["cap"]))

def serve_tasks(server_url: str, jwt_token: str) -> None:
    headers = {"Authorization": f"Bearer {jwt_token}"}

    executors = {
        "debug::echo": execute_debug_echo,
        "shell::bash": execute_shell_bash,
        # All capabilities starting with LLM:: use execute_llm_query
    }

    while True:
        try:
            poll_url = join_url(server_url, "private", "agent", "task", "poll")
            task_info = http_get_json(poll_url, headers=headers, timeout=HTTP_TIMEOUT)

            if task_info and task_info.get("id"):
                id_part = str(task_info["id"]["id"])
                cap_part = str(task_info["id"]["cap"])
                cap_q = cap_part
                id_q = id_part

                take_url = join_url(server_url, "private", "agent", "take", cap_q, id_q)
                r = requests.post(take_url, headers=headers, timeout=HTTP_TIMEOUT)
                r.raise_for_status()
                task = r.json()

                task_id = parse_task_id(task.get("id"))
                capability = task_id.cap
                payload = (task.get("data") or {}).get("payload")

                print(f"Received task: {task_id.to_json()} capability='{capability}'")

                if capability.startswith("LLM::"):
                    execute_llm_query(task_id, capability, payload, server_url, headers)
                else:
                    executor = executors.get(capability)
                    if executor:
                        executor(task_id, capability, payload, server_url, headers)
                    else:
                        print(f"Unknown capability: {capability}")
                        error_report = TaskResultReport(
                            task_id=task_id,
                            status=TaskResultStatus(status="failure", data=(f"Unknown capability: {capability}", timedelta(seconds=5.0))),
                            output={"error": f"Unknown capability: {capability}"},
                            capability=capability,
                        )
                        report_task_result(server_url, error_report, headers)

        except requests.exceptions.Timeout:
            print("Polling for tasks timed out, will retry...")
        except requests.exceptions.RequestException as e:
            print(f"Polling error: {e} (backing off 15s)")
            time.sleep(15)
        except Exception as e:
            print(f"Unexpected error in serve loop: {e}")

        time.sleep(DEFAULT_POLL_SLEEP_SEC)


# =========================
# CLI (Typer)
# =========================

@app.command()
def sysinfo() -> None:
    """Display system information"""
    si = collect_system_info()
    print_system_info(si)

@app.command()
def ollama() -> None:
    """Display detected Ollama models (as LLM capabilities)"""
    caps = get_ollama_models()
    if caps:
        print("Detected Ollama capabilities:")
        for c in caps:
            print(f" - {c}")
    else:
        print("No Ollama capabilities detected.")

@app.command()
def register(
    server: Optional[str] = typer.Option(None, help="Server URL (required if not in config)"),
    key: Optional[str] = typer.Option(None, help="API key (required if not in config)"),
    tier: int = typer.Option(5, help="Performance tier (0-255, default: 5)"),
    caps: List[str] = typer.Option(["debug::echo", "shell::bash", "TTS::kokoro"], "--cap", help="Agent capability; repeatable"),
    capacity: int = typer.Option(1, help="Concurrent task capacity (default: 1)"),
):
    """Register a new agent with the server"""
    cfg = load_config()

    server = server or cfg.get("server")
    api_key = key or cfg.get("apiKey")

    if not server:
        print("Error: --server is required or must be in config")
        raise typer.Exit(code=1)
    if not api_key:
        print("Error: --key is required or must be in config")
        raise typer.Exit(code=1)

    si = collect_system_info()
    print_system_info(si)

    # Merge Ollama models
    ollama_models = get_ollama_models()
    combined_caps = sorted(set(caps + ollama_models))

    print(f"\nRegistering with server: {server}")
    print(f"Capabilities: {combined_caps}")

    reg = register_agent(server, combined_caps, tier, capacity, api_key)
    print("Registration successful!")

    cfg.update({
        "server": server,
        "apiKey": api_key,
        "agentId": reg["agentId"],
        "key": reg["key"],
    })

    print("\nAuthenticating…")
    auth = authenticate_agent(server, reg["agentId"], reg["key"])
    print("Authentication successful!")

    cfg.update({
        "jwtToken": auth["token"],
        "tokenExpiresIn": auth["expiresIn"],
    })
    save_config(cfg)
    print(f"Configuration saved to {CONFIG_FILE}")

    print("\nTesting connection…")
    if test_ping(server, auth["token"]):
        print("✅ Ping test successful - agent is ready!")
    else:
        print("❌ Ping test failed - check server connection")
        raise typer.Exit(code=1)

@app.command()
def serve(
    server: Optional[str] = typer.Option(None, help="Server URL (required if not in config)"),
):
    """Poll and execute tasks"""
    cfg = load_config()
    server = server or cfg.get("server")
    if not server:
        print("Error: --server is required or must be in config")
        raise typer.Exit(code=1)

    agent_id = cfg.get("agentId")
    key = cfg.get("key")
    if not agent_id or not key:
        print("Error: Agent not registered or config incomplete. Run 'register' first.")
        raise typer.Exit(code=1)

    print("\nChecking for local Ollama server…")
    if is_ollama_server_running():
        print("✅ Ollama server is already running.")
    else:
        if not start_ollama_server():
            print("Warning: Continuing without confirmed Ollama. LLM tasks may fail.")

    print("\nAuthenticating to get a fresh JWT token…")
    try:
        auth = authenticate_agent(server, agent_id, key)
        jwt = auth["token"]
        print("Authentication successful.")
        cfg["jwtToken"] = jwt
        save_config(cfg)
    except requests.exceptions.RequestException as e:
        print(f"Authentication failed: {e}")
        raise typer.Exit(code=1)

    print("Starting task polling…")
    serve_tasks(server, jwt)

def main():
    app()

if __name__ == "__main__":
    main()
