"""Built-in executors — imported here to trigger @register decorators."""
from offloadmq_agent.exec import debug, llm, shell

__all__ = ["debug", "llm", "shell"]
