# LangGraph

**Status: Works (tested)**

## What It Is

Graph-based framework for building stateful, multi-step AI agent workflows.
Built on top of langchain-core. Agents as state machines with cycles and branching.

## Why It Works on Workers

- Built on langchain-core (which works on pymode)
- Pure Python — graph traversal, state management
- Agent logic is HTTP orchestration (LLM API calls), not heavy computation
- Durable Objects provide exactly the state persistence LangGraph needs

## Dependencies Resolved

| Dependency | Solution |
|------------|----------|
| langchain-core | Works (tested) |
| pydantic | Compiled pydantic_core.wasm |
| ormsgpack | Pure-Python polyfill wrapping msgpack |
| xxhash | Pure-Python polyfill using hashlib |
| uuid_utils | Pure-Python polyfill using stdlib uuid |
| msgpack | Pure Python, works as-is |
| Namespace packages | Added missing `__init__.py` files |

## What Works

- `StateGraph` construction with typed state (TypedDict)
- Adding nodes and edges (including `START`, `END`)
- Conditional edges with routing functions
- `graph.compile()` — produces executable `CompiledStateGraph`
- `app.invoke()` — runs graph to completion
- `InMemorySaver` — checkpoint creation
- Graph with multiple paths (conditional routing)

## What Has Limitations

- **InMemorySaver with invoke**: Checkpointing during invoke hits weakref
  pickle issues in WASM. Use `graph.compile()` without checkpointer for
  stateless execution, or implement DO-based checkpointing.
- **Cold start**: Full import ~3-4s per test (needs Wizer pre-init for production)

## Why DO + LangGraph Is a Good Fit

LangGraph agents are stateful by design — they maintain conversation state,
tool call history, and graph position across steps. Durable Objects provide:

- **Persistent state** via KV/D1 — agent remembers across requests
- **Hibernation** — agent sleeps between user messages, zero cost
- **Alarms** — background processing, scheduled agent tasks
- **30s CPU per step** — each graph node gets its own CPU budget

## Test Command

```bash
npx vitest run --config vitest-pydantic.config.ts test/langgraph.test.ts
```

## Use Case on Workers

```python
from langgraph.graph import StateGraph, START, END
from typing import TypedDict

class AgentState(TypedDict):
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

graph = StateGraph(AgentState)
graph.add_node("classify", classify)
graph.add_node("handle_error", handle_error)
graph.add_node("handle_success", handle_success)
graph.add_edge(START, "classify")
graph.add_conditional_edges("classify", route)
graph.add_edge("handle_error", END)
graph.add_edge("handle_success", END)

app = graph.compile()
result = app.invoke({"input": "all good", "output": ""})
# result["output"] == "OK: all good"
```
