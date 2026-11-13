"""LangGraph example. Dependencies: langgraph, langchain-ollama.

Exposes read_resource; allowed_tools=[] disables it, null allows it.
Resources map logical names to attached text file paths.
"""

import json
import sys
from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_ollama import ChatOllama
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

request = json.load(sys.stdin)
root = Path(request["data_dir"]).resolve()


@tool
def read_resource(name: str) -> str:
    """Read an attached UTF-8 text resource by its logical name."""
    path = (root / request["resources"][name]).resolve()
    if not path.is_relative_to(root):
        raise ValueError("Resource must be inside the task directory")
    return path.read_text(encoding="utf-8")


registry = {"read_resource": read_resource}
allowed = request.get("allowed_tools")
if allowed is not None and set(allowed) - registry.keys():
    raise ValueError("Unknown allowed tool name")
tools = (
    list(registry.values()) if allowed is None else [registry[name] for name in allowed]
)


def local_llm(role: str | None = None) -> ChatOllama:
    """Use the primary input model, or an explicitly selected named role."""
    selected = request["model"] if role is None else request["models"][role]
    return ChatOllama(model=selected, base_url=request["ollama_base_url"])


llm = local_llm()  # Use local_llm("critic") for the input's critic role.
model = llm.bind_tools(tools) if tools else llm


def generate(state: MessagesState):
    return {"messages": [model.invoke(state["messages"])]}


graph = StateGraph(MessagesState)
graph.add_node("generate", generate)
graph.add_edge(START, "generate")
if tools:
    graph.add_node("tools", ToolNode(tools))
    graph.add_conditional_edges("generate", tools_condition)
    graph.add_edge("tools", "generate")
else:
    graph.add_edge("generate", END)
state = graph.compile().invoke(
    {
        "messages": [
            SystemMessage(content=request["system_prompt"]),
            HumanMessage(content=request["user_prompt"]),
        ]
    }
)
text = str(state["messages"][-1].content)
print(text)
result = {"text": text}
output = request["output"]
if output.get("data_file"):
    Path(output["data_file"]).write_text(json.dumps(result), encoding="utf-8")
for filename in output.get("files", []):
    Path(filename).write_text(text, encoding="utf-8")
