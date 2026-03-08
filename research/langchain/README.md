# langchain-core

**Status: Works**

## What It Is

LLM orchestration framework. Provides message types, prompt templates, output parsers,
runnables (LCEL), and tool abstractions for building LLM-powered applications.

## Why It Works on Workers

- Mostly pure Python — HTTP orchestration, not heavy computation
- ~30MB memory footprint (within 128MB Worker / 256MB DO limit)
- The actual LLM calls are HTTP requests to external APIs (OpenAI, Anthropic, etc.)
- Workers are perfect for this: low-latency HTTP routing at the edge

## Dependencies Resolved

| Dependency | Solution |
|------------|----------|
| pydantic | Compiled pydantic_core.wasm (Rust extension) |
| pydantic-core | Pinned to 2.33.2 to match compiled WASM |
| langsmith | Pure Python, works as-is |
| uuid_utils | Pure-Python polyfill (replaces Rust extension) |
| xxhash | Pure-Python polyfill using hashlib (replaces C extension) |
| multiprocessing | Polyfill with cpu_count() returning 1 |
| tenacity | Pure Python retry library, works as-is |
| xml.sax | Added to stdlib VFS |

## What Works

- `SystemMessage`, `HumanMessage`, `AIMessage` — message types
- `messages_to_dict` — serialization
- `Document` with metadata — for RAG pipelines
- `Serializable` — langchain's serialization protocol
- `stringify_dict`, `stringify_value` — utility functions
- Core imports and version checking

## What's Untested

- `PromptTemplate` / LCEL chains — imports work but take ~9s cold start
  (would work in production with Wizer pre-initialization)
- `ChatOpenAI`, `ChatAnthropic` — need API keys + outbound HTTP
- `@tool` decorator, agents, retrievers
- Streaming responses

## Cold Start

- Light imports (messages, documents): ~2-3s
- Full import chain (runnables, LCEL): ~9s (needs Wizer snapshot)

## Test Command

```bash
npx vitest run --config vitest-pydantic.config.ts test/langchain.test.ts
```

## Use Case on Workers

```python
from langchain_core.messages import HumanMessage, SystemMessage

def on_fetch(request, env):
    # Build messages
    messages = [
        SystemMessage(content="You are helpful."),
        HumanMessage(content=request.json()["prompt"]),
    ]
    # Call LLM via AI Gateway or direct API
    # DO provides state for conversation history
    # 30s CPU budget is plenty for HTTP orchestration
```
