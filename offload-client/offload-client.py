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
from pathlib import Path
from typing import Optional, Dict, Any, List

CONFIG_FILE = ".offload-client.json"

def get_gpu_info() -> Optional[Dict[str, Any]]:
    """
    Get GPU information if available.
    Updated to be more robust on Windows with verbose logging.
    """
    print("Attempting to detect GPU...")
    system = platform.system().lower()

    if system == "windows":
        print("  -> Platform detected as Windows.")
        try:
            # Try NVIDIA first using pynvml
            try:
                print("  -> Trying pynvml...")
                import pynvml
                pynvml.nvmlInit()
                handle_count = pynvml.nvmlDeviceGetCount()
                for i in range(handle_count):
                    handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                    name = pynvml.nvmlDeviceGetName(handle)
                    # pynvml can return bytes or str depending on version, so handle both
                    if isinstance(name, bytes):
                        name = name.decode('utf-8')
                    print(f"     -> Found device: {name}")
                    if "NVIDIA" in name.upper():
                        memory_info = pynvml.nvmlDeviceGetMemoryInfo(handle)
                        pynvml.nvmlShutdown()
                        print(f"  -> Successfully detected GPU with pynvml.")
                        return {
                            "vendor": "NVIDIA",
                            "model": name,
                            "vramMb": memory_info.total // (1024 * 1024)
                        }
                pynvml.nvmlShutdown()
                print("  -> No NVIDIA GPU found with pynvml.")
            except Exception as e:
                print(f"  -> pynvml failed with error: {e}. Falling back to wmic.")
                
            # Fallback to wmic if pynvml fails
            try:
                print("  -> Trying wmic...")
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
                            print("  -> Successfully detected GPU with wmic.")
                            return {
                                "vendor": "NVIDIA",
                                "model": caption,
                                "vramMb": ram // (1024 * 1024)
                            }
                print("  -> No NVIDIA GPU found with wmic.")
            except Exception as e:
                print(f"  -> wmic failed with error: {e}.")
        except Exception as e:
            print(f"  -> An unexpected error occurred in the Windows detection block: {e}")

    elif system == "linux":
        print("  -> Platform detected as Linux.")
        try:
            # Try lspci for Linux
            print("  -> Trying lspci...")
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
                            print(f"  -> Successfully detected GPU with lspci: {gpu_info}")
                            return {
                                "vendor": vendor,
                                "model": gpu_info,
                                "vramMb": 0  # Cannot reliably detect VRAM from lspci
                            }
                print("  -> No GPU found with lspci.")
            else:
                print("  -> lspci command failed.")
        except Exception as e:
            print(f"  -> lspci detection failed with error: {e}")
    
    elif system == "darwin":  # macOS
        print("  -> Platform detected as macOS.")
        try:
            print("  -> Trying system_profiler...")
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
                print(f"  -> Successfully detected GPU with system_profiler: {model}")
                return {
                    "vendor": vendor,
                    "model": model,
                    "vramMb": vram_mb
                }
            print("  -> No GPU found with system_profiler.")
        except Exception as e:
            print(f"  -> system_profiler detection failed with error: {e}")
    
    # Try AMD/other GPUs using GPUtil as a last resort
    try:
        print("  -> Trying GPUtil as a fallback...")
        import GPUtil
        gpus = GPUtil.getGPUs()
        if gpus:
            gpu = gpus[0]
            print(f"  -> Successfully detected GPU with GPUtil: {gpu.name}")
            return {
                "vendor": "Unknown",
                "model": gpu.name,
                "vramMb": int(gpu.memoryTotal)
            }
        print("  -> No GPU found with GPUtil.")
    except ImportError:
        print("  -> GPUtil is not installed.")
    except Exception as e:
        print(f"  -> GPUtil failed with error: {e}")

    print("No GPU detected.")
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
        description="Register agent with offload server",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        "--server", 
        help="Server URL (required if not in config)"
    )
    parser.add_argument(
        "--key", 
        help="API key (required if not in config)"
    )
    parser.add_argument(
        "--tier", 
        type=int, 
        default=5,
        help="Performance tier (0-255, default: 5)"
    )
    parser.add_argument(
        "--caps", 
        nargs='*',
        default=["GENERAL_COMPUTE"],
        help="Agent capabilities (default: ['GENERAL_COMPUTE'])"
    )
    parser.add_argument(
        "--capacity",
        type=int,
        default=1,
        help="Concurrent task capacity (default: 1)"
    )
    
    args = parser.parse_args()
    
    # Load existing configuration
    config = load_config()
    
    # Determine server URL
    server = args.server or config.get("server")
    if not server:
        print("Error: Server URL must be provided via --server or stored in config")
        sys.exit(1)
    
    # Determine API key
    api_key = args.key or config.get("apiKey")
    if not api_key:
        print("Error: API key must be provided via --key or stored in config")
        sys.exit(1)
    
    # Validate tier
    if not (0 <= args.tier <= 255):
        print("Error: Tier must be between 0 and 255")
        sys.exit(1)
    
    print("Collecting system information...")
    system_info = collect_system_info()
    print(f"OS: {system_info['os']}")
    print(f"Architecture: {system_info['cpuArch']}")
    print(f"Memory: {system_info['totalMemoryMb']} MB")
    if system_info['gpu']:
        gpu = system_info['gpu']
        print(f"GPU: {gpu['vendor']} {gpu['model']} ({gpu['vramMb']} MB VRAM)")
    else:
        print("GPU: None detected")
    
    print(f"\nRegistering with server: {server}")
    print(f"Capabilities: {args.caps}")
    print(f"Tier: {args.tier}")
    print(f"Capacity: {args.capacity}")
    
    # Register agent
    registration_response = register_agent(server, args.caps, args.tier, args.capacity, api_key)
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

if __name__ == "__main__":
    main()
