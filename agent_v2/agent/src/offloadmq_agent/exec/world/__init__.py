"""``world.*`` — explorable 3D worlds (Gaussian splats) from a single image."""

from .executor import CAPABILITY, execute_world_splat, find_depth_pack

__all__ = ["CAPABILITY", "execute_world_splat", "find_depth_pack"]
