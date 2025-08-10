#!/usr/bin/env python3
"""
Cross-platform Offload Client Registration Script

This script collects system information and registers with an offload server.
It handles authentication, JWT tokens, and maintains configuration state.
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

    def to_json(self):
        """
        Custom serialization for the TaskResultReport object.
        Handles UUID and Enum types.
        """
        return {
            "taskId": str(self.task_id),
            "status": self.status,
            "output": self.output
        }

def execute_debug_echo(task_id: uuid.UUID, payload: dict, server_url: str, headers):
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
            output=result_output
        )

        # Send the report via POST to the specified server endpoint
        report_url = f"{server_url}/private/agent/task/{report.task_id}"
        
        # requests.post with the 'json' parameter automatically serializes
        # the dictionary and sets the Content-Type header
        print("Reporting echo:", report.to_json())
        response = requests.post(report_url, json=report.to_json(), headers=headers)
        print(response.text)
        response.raise_for_status()

        print(f"Task result for {task_id} reported successfully. Status Code: {response.status_code}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"Failed to report task result for {task_id}: {e}")
        return False
    
def execute_shell_bash(task_id: uuid.UUID, payload: dict, server_url: str, headers: dict):
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
            output=error_output
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
            output=report_output
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
            output=report_output
        )
    except Exception as e:
        # Other errors, like file not found
        report_output = {
            "error": str(e)
        }
        report = TaskResultReport(
            task_id=task_id,
            status="failed",
            output=report_output
        )

    # Send the report via POST to the specified server endpoint
    report_url = f"{server_url}/private/agent/task/{report.task_id}"
    
    try:
        print(f"Reporting shell::bash result for task {task_id}")
        response = requests.post(report_url, json=report.to_json(), headers=headers)
        print(response.text)
        response.raise_for_status()
        print(f"Task result for {task_id} reported successfully. Status Code: {response.status_code}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"Failed to report task result for {task_id}: {e}")
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
            # Poll for an urgent task
            poll_url = f"{server_url}/private/agent/task_urgent/poll"
            poll_response = requests.get(poll_url, headers=headers)
            poll_response.raise_for_status()
            
            print(poll_response.text)
            
            task_info = poll_response.json()
            
            if task_info and task_info.get("id"):
                task_id = task_info.get("id")
                
                # Now, make a POST request to 'take' the task
                take_url = f"{server_url}/private/agent/take_urgent/{task_id}"
                take_response = requests.post(take_url, headers=headers)
                take_response.raise_for_status()
                
                task = take_response.json()
                task_id = uuid.UUID(task.get("id"))
                capability = task.get("capability")
                payload = task.get("payload")

                print(f"Received new task: {task_id} with capability '{capability}'")
                
                executor = capability_map.get(capability)
                if executor:
                    executor(task_id, payload, server_url, headers)
                else:
                    print(f"Unknown capability: {capability}")
                    # You might want to report this failure back to the server
                    # as an unhandled task.
                    # This is a good place to add a new function for error reporting.

            time.sleep(5)  # Poll every 5 seconds

    except requests.exceptions.RequestException as e:
        print(f"An error occurred while serving tasks: {e}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")


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
    """
    Get GPU information if available.
    """
    system = platform.system().lower()

    if system == "windows":
        try:
            # Try NVIDIA first using pynvml
            try:
                import pynvml
                pynvml.nvmlInit()
                handle_count = pynvml.nvmlDeviceGetCount()
                for i in range(handle_count):
                    handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                    name = pynvml.nvmlDeviceGetName(handle)
                    if isinstance(name, bytes):
                        name = name.decode('utf-8')
                    if "NVIDIA" in name.upper():
                        memory_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
                        pynvml.nvmlShutdown()
                        return {
                            "vendor": "NVIDIA",
                            "model": name,
                            "vramMb": memory_info.total // (1024 * 1024)
                        }
                pynvml.nvmlShutdown()
            except Exception:
                pass
                
            # Fallback to wmic if pynvml fails
            try:
                import subprocess
                result = subprocess.run(['wmic', 'path', 'win32_videocontroller', 'get', 'caption,AdapterRAM', '/format:list'], 
                                        capture_output=True, text=True, check=True)
                lines = result.stdout.strip().split('\n')
                caption = None
                ram = None
                for line in lines:
                    if line.strip():
                        if line.startswith('Caption='):
                            caption = line.split('=', 1)[1].strip()
                        elif line.startswith('AdapterRAM='):
                            ram = int(line.split('=', 1)[1].strip())
                        
                        if caption and ram and 'NVIDIA' in caption.upper():
                            return {
                                "vendor": "NVIDIA",
                                "model": caption,
                                "vramMb": ram // (1024 * 1024)
                            }
            except Exception:
                pass
        except Exception:
            pass

    elif system == "linux":
        try:
            # Try lspci for Linux
            import subprocess
            result = subprocess.run(['lspci', '-v'], capture_output=True, text=True)
            if result.returncode == 0:
                lines = result.stdout.split('\n')
                for line in lines:
                    if 'VGA compatible controller' in line or '3D controller' in line:
                        parts = line.split(': ')
                        if len(parts) > 1:
                            gpu_info = parts[1]
                            vendor = "NVIDIA" if "NVIDIA" in gpu_info else \
                                    "AMD" if "AMD" in gpu_info else \
                                    "Intel" if "Intel" in gpu_info else "Unknown"
                            return {
                                "vendor": vendor,
                                "model": gpu_info,
                                "vramMb": 0  # Cannot reliably detect VRAM from lspci
                            }
        except Exception:
            pass
    
    elif system == "darwin":  # macOS
        try:
            import subprocess
            result = subprocess.run(['system_profiler', 'SPDisplaysDataType', '-json'], 
                                  capture_output=True, text=True, check=True)
            display_data = json.loads(result.stdout)
            displays = display_data.get('SPDisplaysDataType', [])
            if displays and displays[0].get('sppci_model'):
                model = displays[0]['sppci_model']
                vram_str = displays[0].get('spdisplays_vram', '0 MB')
                vram_mb = int(vram_str.split()[0]) if vram_str.split()[0].isdigit() else 0
                vendor = "Apple" if "Apple" in model else "Unknown"
                return {
                    "vendor": vendor,
                    "model": model,
                    "vramMb": vram_mb
                }
        except Exception:
            pass
    
    # Try AMD/other GPUs using GPUtil as a last resort
    try:
        import GPUtil
        gpus = GPUtil.getGPUs()
        if gpus:
            gpu = gpus[0]
            return {
                "vendor": "Unknown",
                "model": gpu.name,
                "vramMb": int(gpu.memoryTotal)
            }
    except ImportError:
        pass
    except Exception:
        pass

    return None

def collect_system_info() -> Dict[str, Any]:
    """Collect comprehensive system information."""
    # Get memory in MB
    memory_bytes = psutil.virtual_memory().total
    memory_mb = memory_bytes // (1024 * 1024)
    
    # Get OS information
    system = platform.system()
    if system == "Darwin":
        os_name = f"macOS {platform.mac_ver()[0]}"
    elif system == "Windows":
        os_name = f"Windows {platform.win32_ver()[0]} {platform.win32_ver()[1]}"
    elif system == "Linux":
        try:
            with open('/etc/os-release', 'r') as f:
                lines = f.readlines()
                pretty_name = None
                for line in lines:
                    if line.startswith('PRETTY_NAME='):
                        pretty_name = line.split('=', 1)[1].strip().strip('"')
                        break
                os_name = pretty_name or f"Linux {platform.release()}"
        except FileNotFoundError:
            os_name = f"Linux {platform.release()}"
    else:
        os_name = f"{system} {platform.release()}"
    
    # Get CPU architecture
    cpu_arch = platform.machine()
    
    # Normalize common architecture names
    arch_mapping = {
        'AMD64': 'x86_64',
        'x64': 'x86_64',
        'i386': 'i686',
        'i686': 'i686',
        'aarch64': 'arm64',
        'arm64': 'arm64'
    }
    cpu_arch = arch_mapping.get(cpu_arch, cpu_arch)
    
    system_info = {
        "os": os_name,
        "cpuArch": cpu_arch,
        "totalMemoryMb": memory_mb,
        "gpu": get_gpu_info()
    }
    
    return system_info

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
    
    url = f"{server.rstrip('/')}/agents"
    
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


def main():
    parser = argparse.ArgumentParser(
        description="Offload Client Registration and System Info Script",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    subparsers = parser.add_subparsers(dest='action', required=True, help='Action to perform')

    # Subparser for the 'register' action
    register_parser = subparsers.add_parser('register', help='Register a new agent with the server')
    register_parser.add_argument(
        "--server", 
        help="Server URL (required if not in config)"
    )
    register_parser.add_argument(
        "--key", 
        help="API key (required if not in config)"
    )
    register_parser.add_argument(
        "--tier", 
        type=int, 
        default=5,
        help="Performance tier (0-255, default: 5)"
    )
    register_parser.add_argument(
        "--caps", 
        nargs='*',
        default=["GENERAL_COMPUTE", "debug::echo", "shell::bash"],
        help="Agent capabilities (default: ['GENERAL_COMPUTE'])"
    )
    register_parser.add_argument(
        "--capacity",
        type=int,
        default=1,
        help="Concurrent task capacity (default: 1)"
    )

    # Subparser for the 'sysinfo' action
    subparsers.add_parser('sysinfo', help='Display system information')
    
    # Subparser for the 'ollama' action
    subparsers.add_parser('ollama', help='Display detected Ollama models')
    
    # Subparser for the 'serve' action
    serve_parser = subparsers.add_parser('serve', help='Periodically poll for and take urgent tasks')
    serve_parser.add_argument(
        "--server",
        help="Server URL (required if not in config)"
    )

    args = parser.parse_args()
    
    config = load_config()
    server = args.server or config.get("server")

    if args.action == 'sysinfo':
        system_info = collect_system_info()
        print_system_info(system_info)
    
    elif args.action == 'ollama':
        ollama_capabilities = get_ollama_models()
        if ollama_capabilities:
            print("Ollama capabilities to be sent to server:")
            for cap in ollama_capabilities:
                print(f" - {cap}")
        else:
            print("No Ollama capabilities detected.")

    elif args.action == 'register':
        # Determine API key
        api_key = args.key or config.get("apiKey")
        
        # Check for required arguments
        if not server:
            print("Error: Server URL must be provided via --server or stored in config")
            sys.exit(1)
        if not api_key:
            print("Error: API key must be provided via --key or stored in config")
            sys.exit(1)
        
        # Validate tier
        if not (0 <= args.tier <= 255):
            print("Error: Tier must be between 0 and 255")
            sys.exit(1)

        system_info = collect_system_info()
        print_system_info(system_info)

        # Get Ollama models and combine with user-provided capabilities
        ollama_models = get_ollama_models()
        combined_capabilities = args.caps + ollama_models

        print(f"\nRegistering with server: {server}")
        print(f"Capabilities: {combined_capabilities}")
        print(f"Tier: {args.tier}")
        print(f"Capacity: {args.capacity}")
        
        # Register agent with combined capabilities
        registration_response = register_agent(server, combined_capabilities, args.tier, args.capacity, api_key)
        print(f"\nRegistration successful!")
        print(f"Agent ID: {registration_response['agentId']}")
        print(f"Message: {registration_response['message']}")
        
        # Update config with registration info
        config.update({
            "server": server,
            "apiKey": api_key,
            "agentId": registration_response["agentId"],
            "key": registration_response["key"]
        })
        
        print("\nAuthenticating...")
        # Authenticate and get JWT token
        auth_response = authenticate_agent(server, registration_response["agentId"], registration_response["key"])
        print("Authentication successful!")
        
        # Update config with JWT info
        config.update({
            "jwtToken": auth_response["token"],
            "tokenExpiresIn": auth_response["expiresIn"]
        })
        
        # Save updated configuration
        save_config(config)
        print(f"Configuration saved to {CONFIG_FILE}")
        
        # Test ping
        print("\nTesting connection...")
        if test_ping(server, auth_response["token"]):
            print("✅ Ping test successful - agent is ready!")
        else:
            print("❌ Ping test failed - check server connection")
            sys.exit(1)

    elif args.action == 'serve':
        if not server:
            print("Error: Server URL must be provided via --server or stored in config")
            sys.exit(1)
            
        agent_id = config.get("agentId")
        key = config.get("key")
        jwt_token = config.get("jwtToken")
        
        if not all([agent_id, key, jwt_token]):
            print("Error: Agent not registered or configuration file is incomplete.")
            print("Please run 'register' action first.")
            sys.exit(1)

        print("Authenticating to get a fresh JWT token...")
        try:
            auth_response = authenticate_agent(server, agent_id, key)
            jwt_token = auth_response["token"]
            print("Authentication successful.")
            config["jwtToken"] = jwt_token
            save_config(config)
        except requests.exceptions.RequestException as e:
            print(f"Authentication failed: {e}")
            sys.exit(1)

        serve_tasks(server, jwt_token)

if __name__ == "__main__":
    main()
