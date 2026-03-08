# FastAPI

**Status: Works**

## What It Is

Modern Python web framework with automatic request/response validation via pydantic,
OpenAPI schema generation, and dependency injection.

## Why It Works on Workers

- Pure Python (ASGI framework)
- Built on pydantic (which we have compiled to WASM)
- Built on starlette (pure Python ASGI toolkit)
- ~20MB memory with dependencies

## Why It Makes Sense on Workers (Durable Objects)

At first glance, running a web framework on Workers seems redundant — Workers already
handles HTTP routing. But with Durable Objects:

- **Stateful APIs**: FastAPI routes inside a DO with persistent storage
- **Schema validation**: Pydantic models validate request/response automatically
- **AI Agent APIs**: Multiple endpoints (`/chat`, `/tools`, `/memory`) with typed contracts
- **30s CPU per request**: Plenty for LLM orchestration endpoints

## Dependencies

- starlette (ASGI) — pure Python, works
- pydantic — compiled pydantic_core.wasm
- typing-extensions — pure Python

## What Works

- Route definition with decorators
- Request body validation via pydantic models
- Path/query parameter parsing
- Response model serialization
- TestClient for testing

## Test Command

```bash
npx vitest run --config vitest-pydantic.config.ts test/pydantic.test.ts
# (FastAPI test is in the pydantic test file)
```

## Use Case on Workers

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()

class ChatRequest(BaseModel):
    message: str
    session_id: str

@app.post("/chat")
def chat(req: ChatRequest):
    # Validated input, stateful DO, LLM orchestration
    return {"reply": "..."}
```
