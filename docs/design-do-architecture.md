# Design: PythonDO Architecture

## Summary

PythonDO is a Durable Object that runs the full CPython WASM instance with host-provided
WASM imports for all CF services. Async I/O uses Binaryen Asyncify — the WASM binary is
instrumented at build time so async host imports suspend/resume the call stack in-place.

In project mode, each HTTP request is routed through PythonDO which runs the user's
`on_fetch(request, env)` handler with full access to KV, R2, D1, TCP, HTTP, and threading.

## Request Flow

```
Client → HTTP → PyMode Worker (stateless)
                    │
                    │ serialize CF Request to JSON
                    │
                    ▼
              PythonDO.handleRequest(wasmModule, wasiFactory, requestJson)
                    │
                    │ create WASI with stdin = requestJson
                    │ wrap with Asyncify + pymode.* host imports
                    │ WebAssembly.Instance(python.wasm, wrappedImports)
                    │
                    ▼
              python.wasm _start()
                    │
                    │ python -S -m pymode._handler src.entry
                    │ _handler.py reads stdin JSON → Request object
                    │ imports user's src.entry module
                    │ calls on_fetch(request, env)
                    │
                    ├──→ env.MY_KV.get("key")
                    │      → KVBinding.get()
                    │      → pymode.env.KV.get()
                    │      → _pymode.kv_get()           ← Python C extension
                    │      → WASM import pymode.kv_get   ← WASM boundary
                    │      → Asyncify unwinds stack
                    │      → JS: await env.KV.get(key, "arrayBuffer")
                    │      → Asyncify rewinds stack with result
                    │      → Python receives bytes
                    │
                    ├──→ pymode.http.fetch(url)
                    │      → _pymode.http_fetch()
                    │      → Asyncify suspend → JS fetch() → resume
                    │
                    ├──→ pymode.tcp.connect(host, port)
                    │      → _pymode.tcp_connect() (sync, no Asyncify)
                    │      → cloudflare:sockets connect()
                    │
                    │ handler returns Response object
                    │ _handler.py serializes Response to JSON stdout
                    │
                    ▼
              PythonDO returns { stdout, stderr, exitCode }
                    │
                    ▼
              Worker deserializes stdout JSON → CF Response
                    │
                    ▼
              Client ← HTTP Response
```

## Architecture Diagram

```
┌────────────────────────────────────────────────────────┐
│                     PythonDO                           │
│                 (Durable Object)                       │
│                                                        │
│  ┌──────────────┐         ┌─────────────────────────┐  │
│  │ python.wasm  │         │   Host Import State     │  │
│  │  (CPython)   │ pymode.*│                         │  │
│  │              ├────────→│  TCP connections (Map)   │  │
│  │  User .py    │ imports │  HTTP responses (Map)    │  │
│  │  on_fetch()  │         │  Thread results (Map)    │  │
│  └──────────────┘         └─────────────────────────┘  │
│         │                            │                 │
│   Asyncify suspends           JS implements            │
│   on async imports            using CF APIs            │
│         ↓                            ↓                 │
│  ┌─────────────────────────────────────────────────┐   │
│  │ cloudflare:sockets │ env.KV │ env.R2 │ env.D1  │   │
│  │ global fetch()     │ ThreadDO (child DOs)       │   │
│  └─────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
         ↑
         │ RPC: handleRequest(wasm, wasiFactory, requestJson)
         │
┌────────────────────────────────────────────────────────┐
│  PyMode Worker (stateless)                             │
│                                                        │
│  1. Build VFS: stdlib + pymode + user project files    │
│  2. Serialize CF Request → JSON                        │
│  3. Create WASI factory (args, env, files, stdin)      │
│  4. Call PythonDO.handleRequest()                      │
│  5. Deserialize stdout JSON → CF Response              │
└────────────────────────────────────────────────────────┘
         ↑
         │ HTTP
     [Client]
```

## Host Imports (pymode.* WASM namespace)

### Layer 1: C Header (`lib/pymode-imports/pymode_imports.h`)

```c
__attribute__((import_module("pymode"), import_name("tcp_connect")))
int32_t pymode_tcp_connect(const char* host, int32_t host_len, int32_t port);

__attribute__((import_module("pymode"), import_name("kv_get")))
int32_t pymode_kv_get(const char* key, int32_t key_len, uint8_t* buf, int32_t buf_len);
// ... etc for all imports
```

### Layer 2: CPython Extension (`lib/pymode-imports/pymode_imports.c`)

Registered as built-in module `_pymode` in `config.c`. Python code calls:
```python
import _pymode
result = _pymode.kv_get("key")  # calls the WASM import
```

### Layer 3: Python Wrappers (`lib/pymode/`)

User-facing API:
```python
from pymode.env import KV
data = KV.get("key")  # calls _pymode.kv_get()

# Or via env bindings in handlers:
def on_fetch(request, env):
    data = env.MY_KV.get("key")  # KVBinding → pymode.env.KV → _pymode.kv_get()
```

### Layer 4: JS Implementation (`worker/src/python-do.ts`)

```typescript
kv_get: async (keyPtr, keyLen, bufPtr, bufLen) => {
    const key = self.readString(keyPtr, keyLen);
    const val = await self.env.KV.get(key, "arrayBuffer");
    return self.writeBytes(bufPtr, new Uint8Array(val), bufLen);
},
```

### Async Import Classification

| Host Import | Sync/Async | Reason |
|-------------|-----------|--------|
| `tcp_connect` | Sync | `connect()` returns synchronously |
| `tcp_send` | Sync | `writer.write()` buffers |
| `tcp_recv` | **Async** | Awaits `reader.read()` |
| `tcp_close` | Sync | Cleanup |
| `http_fetch` | **Async** | Awaits `fetch()` + body |
| `http_response_*` | Sync | Reads in-memory buffers |
| `kv_get` | **Async** | Awaits `env.KV.get()` |
| `kv_put` | **Async** | Awaits `env.KV.put()` |
| `kv_delete` | **Async** | Awaits `env.KV.delete()` |
| `r2_get` | **Async** | Awaits `env.R2.get()` |
| `r2_put` | **Async** | Awaits `env.R2.put()` |
| `d1_exec` | **Async** | Awaits `env.D1.prepare().all()` |
| `thread_spawn` | **Async** | Spawns child DO |
| `thread_join` | **Async** | Awaits child DO result |
| `env_get` | Sync | Reads env object |
| `console_log` | Sync | `console.log()` |

## Asyncify

Binaryen's Asyncify instruments the WASM binary at build time. When an async host
import is called, the WASM stack unwinds (saving all locals to a memory buffer), JS
awaits the Promise, then the stack rewinds (restoring locals) and execution resumes.

**Build:**
```bash
wasm-opt -O2 --asyncify \
  --pass-arg=asyncify-imports@pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,... \
  --pass-arg=asyncify-ignore-indirect \
  python.wasm -o python.wasm
```

**Runtime (`worker/src/asyncify.ts`):**
```typescript
const asyncify = new AsyncifyRuntime();
const wrapped = asyncify.wrapImports({
    wasi_snapshot_preview1: wasi.imports,
    pymode: pymodeImports,
}, ASYNC_IMPORTS);
const instance = new WebAssembly.Instance(wasmModule, wrapped);
asyncify.init(instance);
await asyncify.callExport("_start");  // handles all async suspensions
```

Size impact: ~30% overhead (5.7MB → ~7.4MB). Still within CF's 10MB limit.

## Wizer: Deploy-Time Snapshots

Pre-initializes the interpreter by running `__wizer_initialize()` at deploy time and
snapshotting linear memory. At runtime, the snapshot restores in ~5ms.

```bash
wizer python.wasm -o python-snapshot.wasm \
  --allow-wasi --wasm-bulk-memory true \
  --init-func __wizer_initialize \
  --mapdir /stdlib::./stdlib
```

| | Without Wizer | With Wizer |
|---|---|---|
| Py_Initialize | ~10ms | 0ms |
| Import stdlib | ~8ms | 0ms |
| **Cold start** | **~28ms** | **~5ms** |

## Threading: Child DOs

Each spawned thread runs in its own ThreadDO with a separate 30s CPU budget and 128MB memory.

```
PythonDO (main)
  │
  ├──→ ThreadDO #1 (own python.wasm, own CPU budget)
  ├──→ ThreadDO #2
  └──→ ThreadDO #3
```

Communication via pickle serialization. Max 32 concurrent threads (CF service binding limit).

## Project Mode vs Legacy Mode

| | Project Mode | Legacy Mode |
|---|---|---|
| Entry | `on_fetch(request, env)` in `.py` file | POST code string |
| Routing | Through PythonDO (full host imports) | Direct `runWasm` (no host imports) |
| Bindings | `env.MY_KV.get()` works | Not available |
| Async I/O | Asyncify | VFS trampoline |
| Multi-file | Yes (bundled at deploy) | No |
| Trigger | `user-files.ts` present | Fallback when absent |

The worker auto-detects project mode when `user-files.ts` is bundled (generated by
`scripts/bundle-project.sh`). Legacy mode is preserved for backwards compatibility.

## Files

| File | Role |
|------|------|
| `worker/src/worker.ts` | Stateless worker, routes to PythonDO or legacy |
| `worker/src/python-do.ts` | PythonDO — WASM + host imports + Asyncify |
| `worker/src/asyncify.ts` | Asyncify runtime |
| `worker/src/thread-do.ts` | ThreadDO — child DOs for parallelism |
| `lib/pymode-imports/pymode_imports.h` | C declarations for WASM imports |
| `lib/pymode-imports/pymode_imports.c` | CPython `_pymode` extension module |
| `lib/pymode/workers.py` | Request, Response, Env, KVBinding, R2Binding, D1Binding |
| `lib/pymode/_handler.py` | Runtime entry point (stdin JSON → on_fetch → stdout JSON) |
| `lib/pymode/env.py` | KV, R2, D1 static classes |
| `lib/pymode/tcp.py` | TCP socket replacement |
| `lib/pymode/http.py` | HTTP fetch |
| `lib/pymode/parallel.py` | Thread spawning via child DOs |
| `lib/wizer/pymode_wizer.c` | Wizer entry point |
| `scripts/bundle-project.sh` | Bundle user .py files → user-files.ts |
| `scripts/build-phase2.sh` | Build CPython WASM with zig cc + Asyncify |
| `scripts/build-wizer.sh` | Build Wizer snapshot |
| `scripts/generate-stdlib-fs.sh` | Bundle stdlib + pymode into worker |

## Implementation Status

- [x] Phase 1: Host imports + Asyncify — all pymode.* imports working
- [x] Phase 2: Wizer deploy-time snapshots — ~5ms cold starts
- [x] Phase 3: Threading via child DOs — real parallelism
- [x] Phase 4: Project mode — on_fetch handler, multi-file, env bindings
- [ ] Package support — pyproject.toml dependency resolution + bundling
- [ ] `wrangler dev` integration — local development without manual bundle step
