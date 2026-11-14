import type { LanggraphRequest } from '@/api/langgraph'

export const DEFAULT_TOOLS = `from langchain_core.tools import tool


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
`
export const DEFAULT_MAIN = `import json
import sys
from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_ollama import ChatOllama
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from tools import get_tools

request = json.load(sys.stdin)


def local_llm(role=None):
    # Named model roles are selected in the app's input panel.
    model = request["model"] if role is None else request["models"][role]
    return ChatOllama(model=model, base_url=request["ollama_base_url"])


tools = get_tools(request.get("allowed_tools"))
llm = local_llm()
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

result = graph.compile().invoke({"messages": [
    SystemMessage(content=request["system_prompt"]),
    HumanMessage(content=request["user_prompt"]),
]}, config={"recursion_limit": 25})
text = str(result["messages"][-1].content)
print(text)

# Optional structured data and exported files, declared in the Output tab.
output = request.get("output", {})
if output.get("data_file"):
    path = Path(output["data_file"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"text": text}), encoding="utf-8")
for filename in output.get("files", []):
    path = Path(filename)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
`
export const DEFAULT_PYPROJECT = `[project]
name = "oai-langgraph-app"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "langgraph",
    "langchain-ollama",
]
`
export const defaultRequest = (): LanggraphRequest => ({
  capability: '', models: {}, main_py: DEFAULT_MAIN, tools_py: DEFAULT_TOOLS,
  pyproject: DEFAULT_PYPROJECT, system_prompt: 'You are a helpful assistant. Use tools when useful.',
  user_prompt: 'Say hello and explain what you can do.', allowed_tools: null,
  resources: {}, output: { data_file: 'result.json', files: [] }, runtime_secs: 600,
})
