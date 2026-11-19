from langchain_core.tools import tool


@tool
def dummy_tool(text: str) -> str:
    """Echo text to demonstrate a tool call. Replace with your implementation."""
    return f"Dummy tool received: {text}"


def get_tools(allowed_tools):
    registry = {"dummy_tool": dummy_tool}
    if allowed_tools is None:
        return list(registry.values())
    unknown = set(allowed_tools) - registry.keys()
    if unknown:
        raise ValueError(f"Unknown tools: {sorted(unknown)}")
    return [registry[name] for name in allowed_tools]


def describe_tools(tools):
    """Render tools as a bullet list for the {tools} prompt placeholder."""
    if not tools:
        return "(no tools available)"
    return "\n".join(f"- {t.name}: {t.description}" for t in tools)
