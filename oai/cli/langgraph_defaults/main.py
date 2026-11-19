import json
import sys
from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_ollama import ChatOllama
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition
from tools import describe_tools, get_tools

request = json.load(sys.stdin)


def local_llm(role=None):
    # Named model roles are selected in the app's input panel.
    model = request["model"] if role is None else request["models"][role]
    return ChatOllama(model=model, base_url=request["ollama_base_url"])


tools = get_tools(request.get("allowed_tools"))
llm = local_llm()
model = llm.bind_tools(tools) if tools else llm


def render(prompt):
    # {tools} expands to the tools this run exposes (after the allowlist).
    return prompt.replace("{tools}", describe_tools(tools))


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
    SystemMessage(content=render(request["system_prompt"])),
    HumanMessage(content=render(request["user_prompt"])),
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
