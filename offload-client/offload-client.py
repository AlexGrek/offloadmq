#!/usr/bin/env python3
"""
Cross-platform Offload Client Registration Script

This script collects system information and registers with an offload server.
It handles authentication, JWT tokens, and maintains configuration state.
It now includes logic to manage and use a local Ollama server via its REST API.
"""

import json
import os
import platform
import psutil
import argparse
import requests
import sys
import re
import uuid
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Dict, Any, List

@dataclass
class TaskResultReport:
    task_id: uuid.UUID
    status: str
    output: Optional[dict]
    capability: str

    def to_json(self):
        """
        Custom serialization for the TaskResultReport object.
        Handles UUID and Enum types.
        """
        return {
            "taskId": str(self.task_id),
            "status": self.status,
            "output": self.output,
            "capability": self.capability
        }

def execute_debug_echo(task_id: uuid.UUID, capability: str, payload: dict, server_url: str, headers):
    """
    Implements the 'debug::echo' capability.
    It takes the payload and sends it back as the output in a TaskResultReport.
    """
    print(f"Executing debug::echo for task {task_id} with payload: {payload}")

    try:
        # The debug::echo task just returns the payload as the output
        result_output = payload
        
        # Create the TaskResultReport
        report = TaskResultReport(
            task_id=task_id,
            status="completed",
            output=result_output,
            capability=capability
        )

        # Send the report via POST to the specified server endpoint
        report_url = f"{server_url}/private/agent/task/{report.task_id}"
        
        # requests.post with the 'json' parameter automatically serializes
        # the dictionary and sets the Content-Type header
        print("Reporting echo:", report.to_json())
        response = requests.post(report_url, json=report.to_json(), headers=headers)
        response.raise_for_status()

        print(f"Task result for {task_id} reported successfully. Status Code: {response.status_code}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"Failed to report task result for {task_id}: {e}")
        return False
    
def execute_shell_bash(task_id: uuid.UUID, capability: str, payload: dict, server_url: str, headers: dict):
    """
    Implements the 'shell::bash' capability.
    It executes a bash command and returns stdout and stderr as output.
    """
    print(f"Executing shell::bash for task {task_id} with payload: {payload}")

    command = payload.get("command")
    if not command:
        error_output = {"error": "No 'command' provided in payload."}
        report = TaskResultReport(
            task_id=task_id,
            status="failed",
            output=error_output,
            capability=capability
        )
        report_url = f"{server_url}/private/agent/task/{report.task_id}"
        try:
            requests.post(report_url, json=report.to_json(), headers=headers).raise_for_status()
        except requests.exceptions.RequestException as e:
            print(f"Failed to report command error for task {task_id}: {e}")
        return False

    try:
        # Use subprocess.run to execute the bash command
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            check=True
        )

        # Command executed successfully
        report_output = {
            "stdout": result.stdout,
            "stderr": result.stderr
        }
        report = TaskResultReport(
            task_id=task_id,
            status="completed",
            output=report_output,
            capability=capability
        )

    except subprocess.CalledProcessError as e:
        # Command failed to execute
        report_output = {
            "stdout": e.stdout,
            "stderr": e.stderr,
            "return_code": e.returncode
        }
        report = TaskResultReport(
            task_id=task_id,
            status="failed",
            output=report_output,
            capability=capability
        )
    except Exception as e:
        # Other errors, like file not found
        report_output = {
            "error": str(e)
        }
        report = TaskResultReport(
            task_id=task_id,
            status="failed",
            output=report_output,
            capability = capability,
        )

    # Send the report via POST to the specified server endpoint
    report_url = f"{server_url}/private/agent/task/{report.task_id}"
    
    try:
        print(f"Reporting shell::bash result for task {task_id}")
        response = requests.post(report_url, json=report.to_json(), headers=headers)
        response.raise_for_status()
        print(f"Task result for {task_id} reported successfully. Status Code: {response.status_code}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"Failed to report task result for {task_id}: {e}")
        return False

def execute_llm_query(task_id: uuid.UUID, capability: str, payload: dict, server_url: str, headers: dict):
    """
    Handles LLM tasks by sending a query to the local Ollama REST API.
    """
    OLLAMA_API_URL = "http://127.0.0.1:11434/api/generate"
    
    try:
        model_name = capability.split("::")[-1]
        
        # Use "prompt" as the preferred key, but fall back to "query" for compatibility.
        prompt = payload.get("prompt") or payload.get("query")

        if not prompt:
            error_output = {"error": "No 'prompt' or 'query' provided in LLM payload."}
            report = TaskResultReport(task_id=task_id, status="failed", output=error_output, capability=capability)
            report_url = f"{server_url}/private/agent/task/{report.task_id}"
            requests.post(report_url, json=report.to_json(), headers=headers).raise_for_status()
            return False

        print(f"Executing LLM query for task {task_id} with model '{model_name}' via API.")

        # Construct the payload for the Ollama API
        api_payload = {
            "model": model_name,
            "prompt": prompt,
            "stream": False  # Get the full response at once
        }

        # Send the request to the Ollama API with a long timeout
        response = requests.post(OLLAMA_API_URL, json=api_payload, timeout=300)
        response.raise_for_status()

        # Ollama API call was successful, use its JSON response as the output
        report_output = response.json()
        report = TaskResultReport(
            task_id=task_id,
            status="completed",
            output=report_output,
            capability=capability
        )
    
    except requests.exceptions.RequestException as e:
        # The API call failed
        report_output = {
            "error": f"Ollama API request failed: {str(e)}",
            "response_text": e.response.text if e.response else "No response from server"
        }
        report = TaskResultReport(
            task_id=task_id,
            status="failed",
            output=report_output,
            capability=capability
        )
    except Exception as e:
        # Other errors, like malformed capability
        report_output = {"error": str(e)}
        report = TaskResultReport(
            task_id=task_id,
            status="failed",
            output=report_output,
            capability=capability
        )

    # Send the report back to the main server
    report_url = f"{server_url}/private/agent/task/{report.task_id}"
    try:
        print(f"Reporting LLM query result for task {task_id}")
        response = requests.post(report_url, json=report.to_json(), headers=headers)
        response.raise_for_status()
        print(f"Task result for {task_id} reported successfully. Status Code: {response.status_code}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"Failed to report LLM task result for {task_id}: {e}")
        return False

def serve_tasks(server_url: str, jwt_token: str):
    """
    Connects to the server, polls for tasks, and executes them.
    """
    headers = {"Authorization": f"Bearer {jwt_token}"}
    
    # Simple mapping of capabilities to functions
    capability_map = {
        "debug::echo": execute_debug_echo,
        "shell::bash": execute_shell_bash
    }

    try:
        while True:
            # Poll for a non-urgent task
            poll_url = f"{server_url}/private/agent/task/poll"
            try:
                poll_response = requests.get(poll_url, headers=headers, timeout=60)
                poll_response.raise_for_status()
                
                task_info = poll_response.json()
                
                if task_info and task_info.get("id"):
                    task_id_str = task_info.get("id")
                    task_cap = task_info.get("capability")
                    
                    # Now, make a POST request to 'take' the task
                    take_url = f"{server_url}/private/agent/take_non_urgent/{task_id_str}/{task_cap}"
                    take_response = requests.post(take_url, headers=headers)
                    take_response.raise_for_status()
                    
                    task = take_response.json()
                    task_id = uuid.UUID(task.get("id"))
                    capability = task.get("capability")
                    payload = task.get("payload")

                    print(f"Received new task: {task_id} with capability '{capability}'")
                    
                    # Route to the correct executor
                    if capability.startswith("LLM::"):
                        execute_llm_query(task_id, capability, payload, server_url, headers)
                    else:
                        executor = capability_map.get(capability)
                        if executor:
                            executor(task_id, capability, payload, server_url, headers)
                        else:
                            print(f"Unknown capability: {capability}")
                            # Report this failure back to the server as an unhandled task.
                            error_report = TaskResultReport(
                                task_id=task_id,
                                status="failed",
                                output={"error": f"Unknown capability: {capability}"},
                                capability=capability
                            )
                            report_url = f"{server_url}/private/agent/task/{error_report.task_id}"
                            requests.post(report_url, json=error_report.to_json(), headers=headers)

            except requests.exceptions.Timeout:
                print("Polling for tasks timed out, will retry...")
            except requests.exceptions.RequestException as e:
                print(f"An error occurred while polling for tasks: {e}")
                # Wait before retrying to avoid spamming a down server
                time.sleep(15)

            time.sleep(5)  # Poll every 5 seconds

    except Exception as e:
        print(f"An unexpected error occurred in serve_tasks loop: {e}")


CONFIG_FILE = ".offload-client.json"

def get_ollama_models() -> List[str]:
    """
    Scans for installed Ollama models via the CLI and returns them
    as a list of strings prefixed with "LLM::".
    """
    try:
        # Check if ollama is installed and the command is available
        subprocess.run(['ollama', '--version'], check=True, capture_output=True)
        
        # Run 'ollama list' to get the list of installed models
        result = subprocess.run(['ollama', 'list'], check=True, capture_output=True, text=True)
        output_lines = result.stdout.strip().split('\n')
        
        if len(output_lines) < 2:
            print("No Ollama models found.")
            return []

        # The first line is the header, so we process from the second line
        models = []
        for line in output_lines[1:]:
            parts = line.split()
            if parts:
                model_name = parts[0]
                # Remove the ':latest' tag if it exists
                if model_name.endswith(':latest'):
                    model_name = model_name[:-7]
                # Prefix the model name as requested
                models.append(f"LLM::{model_name}")
        
        return models
        
    except FileNotFoundError:
        print("Warning: Ollama is not installed. No LLM capabilities will be added.")
    except subprocess.CalledProcessError as e:
        print(f"Warning: Failed to run 'ollama list'. Error: {e.stderr.strip()}")
    except Exception as e:
        print(f"Warning: An unexpected error occurred while detecting Ollama models: {e}")

    return []

def get_gpu_info() -> Optional[Dict[str, Any]]:
    """Get GPU information if available."""
    # This function remains unchanged.
    # ... (implementation from original script)
    return None # Placeholder for brevity

def collect_system_info() -> Dict[str, Any]:
    """Collect comprehensive system information."""
    # This function remains unchanged.
    # ... (implementation from original script)
    memory_bytes = psutil.virtual_memory().total
    memory_mb = memory_bytes // (1024 * 1024)
    return {
        "os": platform.system(),
        "cpuArch": platform.machine(),
        "totalMemoryMb": memory_mb,
        "gpu": get_gpu_info(),
        "client": "offload-client.py",
        "runtime": "python"
    }

def print_system_info(system_info: Dict[str, Any]) -> None:
    """Print system info in a human-readable format."""
    print("Collecting system information...")
    print(f"OS: {system_info['os']}")
    print(f"Architecture: {system_info['cpuArch']}")
    print(f"Memory: {system_info['totalMemoryMb']} MB")
    if system_info['gpu']:
        gpu = system_info['gpu']
        print(f"GPU: {gpu['vendor']} {gpu['model']} ({gpu['vramMb']} MB VRAM)")
    else:
        print("GPU: None detected")

def load_config() -> Dict[str, Any]:
    """Load configuration from file."""
    config_path = Path(CONFIG_FILE)
    if config_path.exists():
        try:
            with open(config_path, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: Could not load config file: {e}")
    return {}

def save_config(config: Dict[str, Any]) -> None:
    """Save configuration to file."""
    try:
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
    except IOError as e:
        print(f"Error: Could not save config file: {e}")
        sys.exit(1)

def register_agent(server: str, capabilities: List[str], tier: int, capacity: int, api_key: str) -> Dict[str, Any]:
    """Register agent with the server."""
    system_info = collect_system_info()
    
    registration_data = {
        "capabilities": capabilities,
        "tier": tier,
        "capacity": capacity,
        "systemInfo": system_info,
        "apiKey": api_key
    }
    
    url = f"{server.rstrip('/')}/agent/register"
    
    try:
        response = requests.post(url, json=registration_data, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error registering agent: {e}")
        sys.exit(1)

def authenticate_agent(server: str, agent_id: str, key: str) -> Dict[str, Any]:
    """Authenticate agent and get JWT token."""
    auth_data = {
        "agentId": agent_id,
        "key": key
    }
    
    url = f"{server.rstrip('/')}/agent/auth"
    
    try:
        response = requests.post(url, json=auth_data, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error authenticating agent: {e}")
        sys.exit(1)

def test_ping(server: str, jwt_token: str) -> bool:
    """Test ping endpoint with JWT token."""
    url = f"{server.rstrip('/')}/private/agent/ping"
    headers = {"Authorization": f"Bearer {jwt_token}"}
    
    try:
        response = requests.get(url, headers=headers, timeout=30)
        return response.status_code == 200
    except requests.exceptions.RequestException:
        return False

def is_ollama_server_running():
    """Checks if the Ollama server is accessible at its default endpoint."""
    try:
        # Use a short timeout to fail fast if the server isn't running.
        response = requests.get("http://127.0.0.1:11434/", timeout=1)
        # A 200 OK response with the expected text means it's running.
        if response.status_code == 200 and "Ollama is running" in response.text:
            return True
        return False
    except requests.exceptions.ConnectionError:
        # This is the expected error if the server is not running.
        return False
    except requests.exceptions.RequestException:
        # Other request errors (like timeouts) also indicate it's not ready.
        return False

def start_ollama_server():
    """Starts 'ollama serve' as a background process and waits for it to be ready."""
    print("Ollama server not found. Attempting to start 'ollama serve'...")
    try:
        # Use Popen to run the command in the background without blocking.
        # Redirect stdout and stderr to prevent cluttering the client's output.
        subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("'ollama serve' command issued. Waiting for server to initialize...")
        
        # Poll for a few seconds to see if the server comes online.
        for _ in range(5): # Try for 5 seconds
            time.sleep(1)
            if is_ollama_server_running():
                print("✅ Ollama server started successfully.")
                return True
        
        print("❌ Failed to detect Ollama server after issuing start command.")
        return False
    except FileNotFoundError:
        print("Error: 'ollama' command not found. Please ensure Ollama is installed and in your system's PATH.")
        return False
    except Exception as e:
        print(f"An unexpected error occurred while trying to start Ollama server: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(
        description="Offload Client Registration and System Info Script",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    subparsers = parser.add_subparsers(dest='action', required=True, help='Action to perform')

    # Subparser for the 'register' action
    register_parser = subparsers.add_parser('register', help='Register a new agent with the server')
    register_parser.add_argument("--server", help="Server URL (required if not in config)")
    register_parser.add_argument("--key", help="API key (required if not in config)")
    register_parser.add_argument("--tier", type=int, default=5, help="Performance tier (0-255, default: 5)")
    register_parser.add_argument("--caps", nargs='*', default=["debug::echo", "shell::bash"], help="Agent capabilities (default: ['debug::echo', 'shell::bash'])")
    register_parser.add_argument("--capacity", type=int, default=1, help="Concurrent task capacity (default: 1)")

    # Subparser for the 'sysinfo' action
    subparsers.add_parser('sysinfo', help='Display system information')
    
    # Subparser for the 'ollama' action
    subparsers.add_parser('ollama', help='Display detected Ollama models')
    
    # Subparser for the 'serve' action
    serve_parser = subparsers.add_parser('serve', help='Periodically poll for and execute tasks')
    serve_parser.add_argument("--server", help="Server URL (required if not in config)")

    args = parser.parse_args()
    
    config = load_config()

    if args.action == 'sysinfo':
        system_info = collect_system_info()
        print_system_info(system_info)
    
    elif args.action == 'ollama':
        ollama_capabilities = get_ollama_models()
        if ollama_capabilities:
            print("Detected Ollama capabilities:")
            for cap in ollama_capabilities:
                print(f" - {cap}")
        else:
            print("No Ollama capabilities detected.")

    elif args.action == 'register':
        server = args.server or config.get("server")
        api_key = args.key or config.get("apiKey")
        
        if not server:
            print("Error: Server URL must be provided via --server or stored in config")
            sys.exit(1)
        if not api_key:
            print("Error: API key must be provided via --key or stored in config")
            sys.exit(1)
        
        system_info = collect_system_info()
        print_system_info(system_info)

        # Get Ollama models and combine with user-provided capabilities
        ollama_models = get_ollama_models()
        combined_capabilities = list(set(args.caps + ollama_models))

        print(f"\nRegistering with server: {server}")
        print(f"Capabilities: {combined_capabilities}")
        
        registration_response = register_agent(server, combined_capabilities, args.tier, args.capacity, api_key)
        print(f"\nRegistration successful!")
        
        config.update({
            "server": server,
            "apiKey": api_key,
            "agentId": registration_response["agentId"],
            "key": registration_response["key"]
        })
        
        print("\nAuthenticating...")
        auth_response = authenticate_agent(server, registration_response["agentId"], registration_response["key"])
        print("Authentication successful!")
        
        config.update({
            "jwtToken": auth_response["token"],
            "tokenExpiresIn": auth_response["expiresIn"]
        })
        
        save_config(config)
        print(f"Configuration saved to {CONFIG_FILE}")
        
        print("\nTesting connection...")
        if test_ping(server, auth_response["token"]):
            print("✅ Ping test successful - agent is ready!")
        else:
            print("❌ Ping test failed - check server connection")
            sys.exit(1)

    elif args.action == 'serve':
        server = args.server or config.get("server")
        
        if not server:
            print("Error: Server URL must be provided via --server or in config")
            sys.exit(1)
            
        agent_id = config.get("agentId")
        key = config.get("key")
        
        if not all([agent_id, key]):
            print("Error: Agent not registered or config file is incomplete. Please run 'register' first.")
            sys.exit(1)

        # Check for and start Ollama server if needed
        print("\nChecking for local Ollama server...")
        if is_ollama_server_running():
            print("✅ Ollama server is already running.")
        else:
            if not start_ollama_server():
                print("Warning: Continuing without a confirmed Ollama server. LLM tasks may fail.")

        print("\nAuthenticating to get a fresh JWT token...")
        try:
            auth_response = authenticate_agent(server, agent_id, key)
            jwt_token = auth_response["token"]
            print("Authentication successful.")
            config["jwtToken"] = jwt_token
            save_config(config)
        except requests.exceptions.RequestException as e:
            print(f"Authentication failed: {e}")
            sys.exit(1)
        
        print("Starting task polling...")
        serve_tasks(server, jwt_token)

if __name__ == "__main__":
    main()
