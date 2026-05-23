"""Built-in executors — import to register."""
from offloadmq_agent.exec import debug, llm, shell
from offloadmq_agent.exec.routed import register_routed_executors

register_routed_executors()

__all__ = ["debug", "llm", "shell"]
