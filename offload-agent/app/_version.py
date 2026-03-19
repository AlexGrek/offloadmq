"""
App version injected at build time via OFFLOAD_AGENT_VERSION environment variable.
For local development, defaults to 'dev'.
"""
import os

APP_VERSION = os.getenv("OFFLOAD_AGENT_VERSION", "dev")
