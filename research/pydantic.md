# pydantic

**Status: Works**

## What It Is

Data validation and serialization library. The most popular Python validation library,
used by FastAPI, LangChain, and thousands of other packages.

## Why It Works on Workers

- Core validation logic is in pydantic_core (Rust compiled to WASM)
- Python layer is pure Python
- ~15MB memory footprint
- Essential for typed APIs and data contracts

## Build Details

- Requires `python-pydantic-core.wasm` variant (includes compiled pydantic_core Rust extension)
- Pinned to `pydantic==2.11.5` + `pydantic_core==2.33.2` to match compiled WASM
- Version mismatch between pydantic and pydantic_core causes import errors

## What Works

- Model definition with type annotations
- Type coercion (str -> int, etc.)
- Validation with detailed error messages
- JSON serialization (`model_dump_json()`)
- All pydantic v2 features

## Test Command

```bash
npx vitest run --config vitest-pydantic.config.ts test/pydantic.test.ts
```

## Use Case on Workers

```python
from pydantic import BaseModel

class UserRequest(BaseModel):
    name: str
    age: int
    email: str

def on_fetch(request, env):
    data = UserRequest.model_validate_json(request.body)
    # data is fully validated and typed
```
