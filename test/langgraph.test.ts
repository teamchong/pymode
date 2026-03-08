// LangGraph conformance tests — verifies langgraph works in pymode.
//
// LangGraph builds on langchain-core to provide graph-based agent workflows
// with state machines, checkpointing, and tool calling.
//
// Requires python-pydantic-core.wasm variant (pydantic_core Rust extension).
// Run via: npx vitest run --config vitest-pydantic.config.ts test/langgraph.test.ts

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function run(code: string): Promise<{ text: string; status: number }> {
  const response = await SELF.fetch("http://localhost", {
    method: "POST",
    body: code,
  });
  const text = await response.text();
  return { text: text.trim(), status: response.status };
}

describe("langgraph: imports", () => {
  it("imports langgraph and checks version", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
import langgraph
print(f"version={langgraph.__version__}")
print(f"has_version={len(langgraph.__version__) > 0}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_version=True");
  });
});

describe("langgraph: graph construction", () => {
  it("creates a StateGraph with nodes and edges", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
from langgraph.graph import StateGraph, START, END
from typing import TypedDict

class MyState(TypedDict):
    count: int
    message: str

graph = StateGraph(MyState)

def increment(state):
    return {"count": state["count"] + 1}

def greet(state):
    return {"message": f"Hello #{state['count']}"}

graph.add_node("increment", increment)
graph.add_node("greet", greet)
graph.add_edge(START, "increment")
graph.add_edge("increment", "greet")
graph.add_edge("greet", END)

print(f"nodes={len(graph.nodes)}")
print(f"has_increment={'increment' in graph.nodes}")
print(f"has_greet={'greet' in graph.nodes}")
print(f"type={type(graph).__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_increment=True");
    expect(text).toContain("has_greet=True");
    expect(text).toContain("type=StateGraph");
  });
});

describe("langgraph: compile and invoke", () => {
  it("compiles and invokes a simple graph", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
from langgraph.graph import StateGraph, START, END
from typing import TypedDict

class CountState(TypedDict):
    value: int

def add_one(state):
    return {"value": state["value"] + 1}

def add_two(state):
    return {"value": state["value"] + 2}

graph = StateGraph(CountState)
graph.add_node("add_one", add_one)
graph.add_node("add_two", add_two)
graph.add_edge(START, "add_one")
graph.add_edge("add_one", "add_two")
graph.add_edge("add_two", END)

app = graph.compile()

result = app.invoke({"value": 10})
print(f"result={result['value']}")
print(f"type={type(app).__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=13");
    expect(text).toContain("type=CompiledStateGraph");
  });
});

describe("langgraph: conditional edges", () => {
  it("routes based on state with conditional edges", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
from langgraph.graph import StateGraph, START, END
from typing import TypedDict

class RouterState(TypedDict):
    input: str
    output: str

def classify(state):
    if "error" in state["input"].lower():
        return {"output": "error_path"}
    return {"output": "success_path"}

def handle_error(state):
    return {"output": f"ERROR: {state['input']}"}

def handle_success(state):
    return {"output": f"OK: {state['input']}"}

def route(state):
    if state["output"] == "error_path":
        return "handle_error"
    return "handle_success"

graph = StateGraph(RouterState)
graph.add_node("classify", classify)
graph.add_node("handle_error", handle_error)
graph.add_node("handle_success", handle_success)
graph.add_edge(START, "classify")
graph.add_conditional_edges("classify", route)
graph.add_edge("handle_error", END)
graph.add_edge("handle_success", END)

app = graph.compile()

r1 = app.invoke({"input": "all good", "output": ""})
print(f"success={r1['output']}")

r2 = app.invoke({"input": "error occurred", "output": ""})
print(f"error={r2['output']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("success=OK: all good");
    expect(text).toContain("error=ERROR: error occurred");
  });
});

describe("langgraph: checkpoint and memory", () => {
  it("uses InMemorySaver for checkpointing", { timeout: 20000 }, async () => {
    const { text, status } = await run(`
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.base import create_checkpoint, empty_checkpoint

saver = InMemorySaver()
print(f"saver_type={type(saver).__name__}")

cp = empty_checkpoint()
print(f"checkpoint_type={type(cp).__name__}")
print(f"has_id={'id' in cp}")
print(f"has_ts={'ts' in cp}")
`);
    expect(status).toBe(200);
    expect(text).toContain("saver_type=InMemorySaver");
    expect(text).toContain("has_id=True");
  });
});
