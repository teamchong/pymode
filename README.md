# PyMode

**Python on Cloudflare Workers** — write Python handlers, deploy to the edge.

CPython 3.13 compiled to WASM with `zig cc`. 5.7MB binary (1.8MB gzipped). Runs on Workers with full access to KV, R2, D1, TCP, and HTTP.

## Quick Start

```bash
# Create a new project
npx pymode init my-worker
cd my-worker

# Start local dev server (uses native Python, instant reload)
pymode dev
# → Listening on http://localhost:8787

# Deploy to Cloudflare Workers
pymode deploy
```

Your handler (`src/entry.py`):

```python
from pymode.workers import Response

def on_fetch(request, env):
    return Response("Hello from PyMode!")
```

## How It Works

You write `.py` files with an `on_fetch(request, env)` handler — same pattern as CF Python Workers. PyMode bundles your project files into the worker at deploy time and routes each request through PythonDO with full host imports via Asyncify.

```
CF Request
  → Worker serializes request to JSON
  → PythonDO runs python.wasm with Asyncify + pymode.* host imports
    → _handler.py imports your entry module
    → Calls on_fetch(request, env)
    → env.MY_KV.get("key") → _pymode.kv_get() → Asyncify suspends
      → JS awaits env.KV.get() → Asyncify resumes with result
    → Handler returns Response
  → Worker deserializes response JSON → CF Response
```

## Features

### Request Handler Pattern

```python
from pymode.workers import Response

def on_fetch(request, env):
    if request.path == "/api/data":
        data = env.MY_KV.get("key", type="json")
        return Response.json(data)

    if request.path == "/greet":
        name = request.query.get("name", ["World"])[0]
        return Response(f"Hello, {name}!")

    return Response("Not Found", status=404)
```

### CF Bindings via Host Imports

Direct access to KV, R2, D1 through WASM host imports — no serialization overhead:

```python
def on_fetch(request, env):
    # KV — auto-detected from naming convention (*_KV or KV)
    value = env.MY_KV.get("key")
    env.MY_KV.put("key", "value")

    # R2
    data = env.MY_R2.get("file.bin")
    env.MY_R2.put("file.bin", binary_data)

    # D1
    result = env.MY_DB.prepare("SELECT * FROM users WHERE id = ?").bind(42).all()

    # Environment variables / secrets
    api_key = env.API_KEY
```

Under the hood, `env.MY_KV.get("key")` calls `_pymode.kv_get()` which is a WASM host import. Asyncify suspends the WASM stack, JS awaits the real CF KV binding, then resumes Python.

### Packages

Install pure-Python packages from PyPI:

```bash
pymode add requests jinja2
pymode install            # reinstall from pyproject.toml
```

Packages are downloaded as wheels to `.pymode/packages/` and available
in both dev mode and production. Only pure-Python packages work on
Workers (no C extensions).

```python
import requests
from pymode.workers import Response

def on_fetch(request, env):
    resp = requests.get("https://api.example.com/data")
    return Response.json(resp.json())
```

### Multi-File Projects

```
my-worker/
  pyproject.toml          # [tool.pymode] main = "src/entry.py"
  src/
    entry.py              # def on_fetch(request, env): ...
    routes.py             # import from other files normally
    middleware.py
    utils.py
```

All `.py` files are bundled into the VFS at deploy time. Import sibling files naturally:

```python
# src/entry.py
from helpers import greet       # sibling import (same directory)
from src.utils import validate  # absolute import (from project root)
```

### TCP Connections

Database drivers work through persistent TCP connections:

```python
from pymode.tcp import PyModeSocket as socket

sock = socket()
sock.connect(("db.example.com", 5432))
sock.send(b"SELECT 1")
data = sock.recv(4096)
```

### HTTP Fetch

```python
from pymode.http import fetch

response = fetch("https://api.example.com/data")
print(response.status, response.text)
```

### Threading via Child DOs

Real parallelism — each thread runs in its own Durable Object with a separate 30s CPU budget:

```python
from pymode.parallel import spawn, gather

task1 = spawn(process_chunk, data[:1000])
task2 = spawn(process_chunk, data[1000:])
results = gather(task1, task2)
```

### Workflows

Durable multi-step execution with retries and backoff:

```python
from pymode.workflows import Workflow

workflow = Workflow("order-processing")

@workflow.step
def validate(ctx):
    return {"valid": True, "item": ctx.input["item"]}

@workflow.step(retries=3, backoff=2.0)
def charge(ctx):
    order = ctx.results["validate"]
    return {"charged": True, "total": 29.97}

@workflow.step
def confirm(ctx):
    return {"status": "confirmed"}
```

```bash
# Run the workflow
curl -X POST http://localhost:8787/workflow/run \
  -d '{"input": {"item": "widget", "quantity": 3}}'
```

### Deploy-Time Snapshots (Wizer)

Pre-initialize the interpreter at deploy time for ~5ms cold starts:

```bash
pymode deploy --wizer
```

Or enable permanently in `pyproject.toml`:

```toml
[tool.pymode]
wizer = true
```

| | Without Wizer | With Wizer |
|---|---|---|
| Cold start | ~28ms | ~5ms |

## Binary Size

| Build | Size | Gzipped |
|-------|------|---------|
| Pyodide (Emscripten) | ~20 MB | ~6.4 MB |
| CPython WASI SDK | 28 MB | ~8 MB |
| **PyMode (zig cc)** | **5.7 MB** | **1.8 MB** |
| PyMode + Asyncify | ~7.4 MB | ~2.3 MB |

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                     PythonDO                           │
│                 (Durable Object)                       │
│                                                        │
│  ┌──────────────┐         ┌─────────────────────────┐  │
│  │ python.wasm  │         │   Host Import State     │  │
│  │  (CPython)   │ pymode.*│                         │  │
│  │              ├────────→│  TCP connections         │  │
│  │  User .py    │ imports │  HTTP response buffers   │  │
│  │  on_fetch()  │         │  Thread results          │  │
│  └──────────────┘         └─────────────────────────┘  │
│         │                            │                 │
│   Asyncify suspends           JS implements            │
│   on async imports            using CF APIs            │
│         ↓                            ↓                 │
│  ┌─────────────────────────────────────────────────┐   │
│  │ cloudflare:sockets │ env.KV │ env.R2 │ env.D1  │   │
│  │ global fetch()     │ env.AI │ ThreadDO          │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
         ↑
         │ RPC
┌────────────────┐
│  PyMode Worker │  (stateless, routes to PythonDO)
└────────────────┘
         ↑ HTTP
     [Client]
```

## CLI

```bash
pymode init <name>       # Scaffold a new project
pymode dev               # Local dev server (native Python, hot reload)
pymode deploy            # Bundle + deploy to Cloudflare Workers
pymode add <package>     # Add a Python package dependency
pymode remove <package>  # Remove a package dependency
pymode install           # Install all deps from pyproject.toml
```

Options:
- `pymode dev --port 3000` — Custom port (default: 8787)
- `pymode dev --entry app.py` — Override entry point
- `pymode dev --env API_KEY=secret` — Pass env vars (repeatable)
- `pymode dev --verbose` — Log request/response bodies
- `pymode deploy --wizer` — Build Wizer snapshot for fast cold starts
- `pymode deploy ./path/to/project` — Deploy from a specific directory

The dev server uses native Python for instant feedback (~35ms per request).
No WASM build required for local development. CORS is enabled by default for
cross-origin requests during development.

### Environment Variables

The dev server loads environment variables from `.dev.vars` in your project root
(same convention as wrangler):

```
# .dev.vars
API_KEY=my-secret-key
DB_URL="postgres://localhost/mydb"
```

These are accessible in your handler via `env.API_KEY`, `env.DB_URL`, etc.
You can also pass vars via CLI: `pymode dev --env API_KEY=secret`.

Add `.dev.vars` to your `.gitignore` — it contains secrets.

## Building from Source

Only needed if you're contributing to PyMode or need a custom python.wasm build.
Users can use the pre-built binary from npm/releases.

```bash
# Prerequisites: python3, wasmtime, zig 0.15+, wasm-opt

# Build CPython WASM
./scripts/build-phase2.sh

# Generate stdlib bundle
./scripts/generate-stdlib-fs.sh

# (Optional) Build Wizer snapshot for fast cold starts
./scripts/build-wizer.sh
```

## Project Structure

| Path | Description |
|------|-------------|
| `cli/` | `pymode` CLI (init, dev, deploy) |
| `worker/src/worker.ts` | Stateless Worker entry point |
| `worker/src/python-do.ts` | PythonDO — WASM instance + host imports + Asyncify |
| `worker/src/asyncify.ts` | Asyncify runtime (stack unwind/rewind) |
| `worker/src/thread-do.ts` | ThreadDO — child DOs for parallel execution |
| `lib/pymode/workers.py` | Request, Response, Env (CF Python Workers API) |
| `lib/pymode/_handler.py` | Runtime entry point — imports user module, calls handler |
| `lib/pymode/tcp.py` | TCP socket replacement |
| `lib/pymode/http.py` | HTTP fetch |
| `lib/pymode/env.py` | KV, R2, D1 via host imports |
| `lib/pymode/parallel.py` | Threading via child DOs |
| `lib/pymode/workflows.py` | Durable multi-step workflows |
| `lib/pymode-imports/` | C extension wrapping WASM host imports |
| `lib/wizer/` | Wizer entry point for deploy-time snapshots |
| `scripts/bundle-project.sh` | Bundle .py project into worker |
| `scripts/build-phase2.sh` | Build CPython WASM with zig cc |
| `scripts/build-wizer.sh` | Build Wizer snapshot |
| `scripts/generate-stdlib-fs.sh` | Bundle stdlib + pymode into worker |
| `examples/hello-worker/` | Simple handler example |
| `examples/api-worker/` | Multi-file project with KV |
| `examples/workflow-worker/` | Durable workflow with retries |

## Comparison: PyMode vs CF Python Workers

| | CF Python Workers | PyMode |
|---|---|---|
| Handler pattern | `on_fetch(request, env)` | `on_fetch(request, env)` |
| Multi-file projects | Yes | Yes |
| Env bindings | `env.MY_KV.get()` (JS interop) | `env.MY_KV.get()` (host imports) |
| Async I/O | Emscripten Asyncify | Binaryen Asyncify |
| Binary size | ~20MB+ | ~7.4MB |
| Cold start | ~50ms (snapshot) | ~5ms (Wizer) |
| TCP connections | No | Yes |
| Threading | `asyncio.gather` only | Real parallelism (child DOs) |
| Package support | 280+ (Pyodide wheels) | Pure-Python PyPI packages |
| Portability | CF only (Emscripten) | Any WASI host |

## License

MIT
