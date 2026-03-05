# Design: PythonDO — Full Python Runtime in a Durable Object

## Summary

Run the entire CPython WASM instance inside a Durable Object. The DO holds the
interpreter, TCP connections, and CF binding access in one place. Host-provided
WASM imports replace the VFS trampoline. Async ops use an in-process trampoline
(throw → catch → await → re-run, microseconds not network hops).
Deploy-time Wizer snapshots eliminate import overhead.

This matches CF Python Workers (Pyodide) on every dimension and exceeds them
on binary size (5.7MB vs 20MB+) and portability (WASI vs Emscripten).

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  PythonDO                        │
│              (Durable Object)                    │
│                                                  │
│  ┌──────────────────┐    ┌────────────────────┐  │
│  │   python.wasm    │    │  In-Memory State   │  │
│  │   (CPython)      │    │                    │  │
│  │                  │    │  TCP connections    │  │
│  │  WASM imports:   │    │  Response buffers  │  │
│  │   pymode.*  ─────┼───→│  Interpreter state │  │
│  │   wasi_*         │    │                    │  │
│  └──────────────────┘    └────────────────────┘  │
│           │                        │             │
│    host import calls         JS implements       │
│           ↓                        ↓             │
│  ┌──────────────────────────────────────────┐    │
│  │  cloudflare:sockets  │  env.KV           │    │
│  │  global fetch()      │  env.R2           │    │
│  │  env.D1              │  env.AI           │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
          ↑
          │ RPC (1 billed request per session)
          │
┌──────────────────┐
│  PyMode Worker   │  (stateless entry point)
│  routes to DO    │
└──────────────────┘
          ↑
          │ HTTP
      [Client]
```

### Why WASM Lives Inside the DO

| Concern | WASM in Worker (old) | WASM in DO (new) |
|---------|---------------------|-------------------|
| TCP connections | Separate TcpPoolDO, RPC per socket op | Same memory space, direct access |
| Interpreter state | Lost each request | Persists 70-140s (warm interpreter) |
| Trampoline cost | Re-execute entire Python per I/O op | In-process (microseconds), same memory space |
| CF bindings | VFS file passing | Direct host import calls |
| Connection pool | DO holds socket, Worker holds WASM — two hops | One DO holds both — zero hops |
| Cold start | Every request | Only after 70-140s idle |

## Three Layers

### Layer 1: Host Imports (`pymode` WASM namespace)

WASM imports provided by JS when instantiating `python.wasm`. These are the
only way Python communicates with the outside world. No VFS file passing.

```c
// In CPython C code — imported from the JS host

// TCP
__attribute__((import_module("pymode"), import_name("tcp_connect")))
int32_t pymode_tcp_connect(const char* host, int32_t host_len, int32_t port);

__attribute__((import_module("pymode"), import_name("tcp_send")))
int32_t pymode_tcp_send(int32_t conn_id, const uint8_t* data, int32_t len);

__attribute__((import_module("pymode"), import_name("tcp_recv")))
int32_t pymode_tcp_recv(int32_t conn_id, uint8_t* buf, int32_t buf_len);

__attribute__((import_module("pymode"), import_name("tcp_close")))
void pymode_tcp_close(int32_t conn_id);

// HTTP
__attribute__((import_module("pymode"), import_name("http_fetch")))
int32_t pymode_http_fetch(
    const char* url, int32_t url_len,
    const char* method, int32_t method_len,
    const uint8_t* body, int32_t body_len,
    const char* headers_json, int32_t headers_len);

__attribute__((import_module("pymode"), import_name("http_response_status")))
int32_t pymode_http_response_status(int32_t response_id);

__attribute__((import_module("pymode"), import_name("http_response_read")))
int32_t pymode_http_response_read(int32_t response_id, uint8_t* buf, int32_t buf_len);

__attribute__((import_module("pymode"), import_name("http_response_header")))
int32_t pymode_http_response_header(
    int32_t response_id,
    const char* name, int32_t name_len,
    char* buf, int32_t buf_len);

// KV
__attribute__((import_module("pymode"), import_name("kv_get")))
int32_t pymode_kv_get(const char* key, int32_t key_len, uint8_t* buf, int32_t buf_len);

__attribute__((import_module("pymode"), import_name("kv_put")))
void pymode_kv_put(const char* key, int32_t key_len, const uint8_t* val, int32_t val_len);

__attribute__((import_module("pymode"), import_name("kv_delete")))
void pymode_kv_delete(const char* key, int32_t key_len);

// R2
__attribute__((import_module("pymode"), import_name("r2_get")))
int32_t pymode_r2_get(const char* key, int32_t key_len, uint8_t* buf, int32_t buf_len);

__attribute__((import_module("pymode"), import_name("r2_put")))
void pymode_r2_put(const char* key, int32_t key_len, const uint8_t* val, int32_t val_len);

// D1 (SQL)
__attribute__((import_module("pymode"), import_name("d1_exec")))
int32_t pymode_d1_exec(
    const char* sql, int32_t sql_len,
    const char* params_json, int32_t params_len,
    char* result_buf, int32_t result_buf_len);

// Environment
__attribute__((import_module("pymode"), import_name("env_get")))
int32_t pymode_env_get(const char* key, int32_t key_len, char* buf, int32_t buf_len);

// Logging
__attribute__((import_module("pymode"), import_name("console_log")))
void pymode_console_log(const char* msg, int32_t msg_len);
```

### Layer 2: Python Shim Modules

Thin Python modules that call host imports. Installed as part of the stdlib.

```python
# pymode/tcp.py — calls host imports directly

import ctypes

_lib = ctypes.CDLL(None)  # access WASM exports/imports

def _tcp_connect(host: str, port: int) -> int:
    host_bytes = host.encode()
    return _lib.pymode_tcp_connect(host_bytes, len(host_bytes), port)

def _tcp_send(conn_id: int, data: bytes) -> int:
    return _lib.pymode_tcp_send(conn_id, data, len(data))

def _tcp_recv(conn_id: int, bufsize: int) -> bytes:
    buf = ctypes.create_string_buffer(bufsize)
    n = _lib.pymode_tcp_recv(conn_id, buf, bufsize)
    return buf.raw[:n]

def _tcp_close(conn_id: int):
    _lib.pymode_tcp_close(conn_id)


class PyModeSocket:
    def __init__(self, family=2, type=1, proto=0, fileno=None):
        self._conn_id = -1
        self._timeout = None

    def connect(self, addr):
        host, port = addr[0], addr[1]
        self._conn_id = _tcp_connect(host, port)

    def send(self, data, flags=0):
        raw = data if isinstance(data, bytes) else bytes(data)
        return _tcp_send(self._conn_id, raw)

    def sendall(self, data, flags=0):
        raw = data if isinstance(data, bytes) else bytes(data)
        _tcp_send(self._conn_id, raw)

    def recv(self, bufsize, flags=0):
        return _tcp_recv(self._conn_id, bufsize)

    def close(self):
        if self._conn_id >= 0:
            _tcp_close(self._conn_id)
            self._conn_id = -1

    # ... rest of socket API (settimeout, makefile, etc.)
```

```python
# pymode/env.py — access CF bindings

import ctypes
import json

_lib = ctypes.CDLL(None)

class KV:
    @staticmethod
    def get(key: str) -> bytes | None:
        key_bytes = key.encode()
        buf = ctypes.create_string_buffer(1024 * 1024)  # 1MB max
        n = _lib.pymode_kv_get(key_bytes, len(key_bytes), buf, len(buf))
        if n < 0:
            return None
        return buf.raw[:n]

    @staticmethod
    def put(key: str, value: bytes):
        key_bytes = key.encode()
        _lib.pymode_kv_put(key_bytes, len(key_bytes), value, len(value))

    @staticmethod
    def delete(key: str):
        key_bytes = key.encode()
        _lib.pymode_kv_delete(key_bytes, len(key_bytes))


class R2:
    @staticmethod
    def get(key: str) -> bytes | None:
        key_bytes = key.encode()
        buf = ctypes.create_string_buffer(10 * 1024 * 1024)  # 10MB max
        n = _lib.pymode_r2_get(key_bytes, len(key_bytes), buf, len(buf))
        if n < 0:
            return None
        return buf.raw[:n]

    @staticmethod
    def put(key: str, value: bytes):
        key_bytes = key.encode()
        _lib.pymode_r2_put(key_bytes, len(key_bytes), value, len(value))


class D1:
    @staticmethod
    def execute(sql: str, params=None) -> list[dict]:
        sql_bytes = sql.encode()
        params_json = json.dumps(params or []).encode()
        buf = ctypes.create_string_buffer(10 * 1024 * 1024)
        n = _lib.pymode_d1_exec(
            sql_bytes, len(sql_bytes),
            params_json, len(params_json),
            buf, len(buf))
        if n <= 0:
            return []
        return json.loads(buf.raw[:n])


def get_env(key: str) -> str | None:
    key_bytes = key.encode()
    buf = ctypes.create_string_buffer(8192)
    n = _lib.pymode_env_get(key_bytes, len(key_bytes), buf, len(buf))
    if n < 0:
        return None
    return buf.raw[:n].decode()
```

### Layer 3: JS Host Implementation (inside PythonDO)

```typescript
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

interface PythonDOEnv {
  KV?: KVNamespace;
  R2?: R2Bucket;
  D1?: D1Database;
  AI?: any;
  [key: string]: unknown;
}

export class PythonDO extends DurableObject<PythonDOEnv> {
  private wasmInstance: WebAssembly.Instance | null = null;
  private wasmMemory: WebAssembly.Memory | null = null;

  // Persistent TCP connections — survive across RPC calls
  private tcpConns = new Map<number, {
    socket: any;
    reader: ReadableStreamDefaultReader<Uint8Array>;
    writer: WritableStreamDefaultWriter<Uint8Array>;
  }>();
  private nextConnId = 1;

  // HTTP response buffer — stores fetch results for Python to read
  private httpResponses = new Map<number, {
    status: number;
    headers: Headers;
    body: Uint8Array;
    offset: number;
  }>();
  private nextResponseId = 1;

  // Shared buffer for passing data between host imports and WASM
  // (Used when JSPI is not available — trampoline writes here)
  private pendingResult: ArrayBuffer | null = null;

  private getMemory(): DataView {
    return new DataView(this.wasmMemory!.buffer);
  }

  private getMemBytes(): Uint8Array {
    return new Uint8Array(this.wasmMemory!.buffer);
  }

  private readString(ptr: number, len: number): string {
    return new TextDecoder().decode(this.getMemBytes().subarray(ptr, ptr + len));
  }

  private writeBytes(ptr: number, data: Uint8Array, maxLen: number): number {
    const n = Math.min(data.length, maxLen);
    this.getMemBytes().set(data.subarray(0, n), ptr);
    return n;
  }

  private createHostImports(): Record<string, Function> {
    return {
      // --- TCP ---
      tcp_connect: (hostPtr: number, hostLen: number, port: number): number => {
        const host = this.readString(hostPtr, hostLen);
        const connId = this.nextConnId++;
        const socket = connect({ hostname: host, port });
        const writer = socket.writable.getWriter();
        const reader = socket.readable.getReader();
        this.tcpConns.set(connId, { socket, writer, reader });
        return connId;
      },

      tcp_send: (connId: number, dataPtr: number, dataLen: number): number => {
        const conn = this.tcpConns.get(connId);
        if (!conn) return -1;
        const data = this.getMemBytes().slice(dataPtr, dataPtr + dataLen);
        conn.writer.write(data);  // fire-and-forget for sends
        return dataLen;
      },

      tcp_recv: (connId: number, bufPtr: number, bufLen: number): number => {
        // With JSPI: this function is marked Suspending — it returns a Promise
        // that the WASM stack awaits transparently.
        // Without JSPI: this triggers the in-process trampoline.
        const conn = this.tcpConns.get(connId);
        if (!conn) return -1;
        // JSPI path — return Promise, WASM suspends
        // (see JSPI section below for how this is wired)
        throw new Error("tcp_recv requires JSPI or trampoline");
      },

      tcp_close: (connId: number): void => {
        const conn = this.tcpConns.get(connId);
        if (!conn) return;
        try { conn.writer.releaseLock(); } catch {}
        try { conn.reader.releaseLock(); } catch {}
        try { conn.socket.close(); } catch {}
        this.tcpConns.delete(connId);
      },

      // --- HTTP ---
      http_fetch: (
        urlPtr: number, urlLen: number,
        methodPtr: number, methodLen: number,
        bodyPtr: number, bodyLen: number,
        headersPtr: number, headersLen: number
      ): number => {
        // With JSPI: suspendable. Without: trampoline.
        throw new Error("http_fetch requires JSPI or trampoline");
      },

      http_response_status: (responseId: number): number => {
        const resp = this.httpResponses.get(responseId);
        return resp ? resp.status : -1;
      },

      http_response_read: (responseId: number, bufPtr: number, bufLen: number): number => {
        const resp = this.httpResponses.get(responseId);
        if (!resp) return -1;
        const remaining = resp.body.length - resp.offset;
        const n = Math.min(remaining, bufLen);
        this.getMemBytes().set(resp.body.subarray(resp.offset, resp.offset + n), bufPtr);
        resp.offset += n;
        return n;
      },

      http_response_header: (
        responseId: number,
        namePtr: number, nameLen: number,
        bufPtr: number, bufLen: number
      ): number => {
        const resp = this.httpResponses.get(responseId);
        if (!resp) return -1;
        const name = this.readString(namePtr, nameLen);
        const value = resp.headers.get(name);
        if (!value) return -1;
        const encoded = new TextEncoder().encode(value);
        return this.writeBytes(bufPtr, encoded, bufLen);
      },

      // --- KV ---
      kv_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
        // Suspendable with JSPI
        throw new Error("kv_get requires JSPI or trampoline");
      },

      kv_put: (keyPtr: number, keyLen: number, valPtr: number, valLen: number): void => {
        // Suspendable with JSPI
        throw new Error("kv_put requires JSPI or trampoline");
      },

      kv_delete: (keyPtr: number, keyLen: number): void => {
        // Suspendable with JSPI
        throw new Error("kv_delete requires JSPI or trampoline");
      },

      // --- R2 ---
      r2_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
        throw new Error("r2_get requires JSPI or trampoline");
      },

      r2_put: (keyPtr: number, keyLen: number, valPtr: number, valLen: number): void => {
        throw new Error("r2_put requires JSPI or trampoline");
      },

      // --- D1 ---
      d1_exec: (
        sqlPtr: number, sqlLen: number,
        paramsPtr: number, paramsLen: number,
        resultPtr: number, resultLen: number
      ): number => {
        throw new Error("d1_exec requires JSPI or trampoline");
      },

      // --- Environment ---
      env_get: (keyPtr: number, keyLen: number, bufPtr: number, bufLen: number): number => {
        const key = this.readString(keyPtr, keyLen);
        const value = this.env[key];
        if (value === undefined || value === null) return -1;
        const encoded = new TextEncoder().encode(String(value));
        return this.writeBytes(bufPtr, encoded, bufLen);
      },

      // --- Logging ---
      console_log: (msgPtr: number, msgLen: number): void => {
        console.log(this.readString(msgPtr, msgLen));
      },
    };
  }

  async run(code: string, wasmModule: WebAssembly.Module): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const hostImports = this.createHostImports();

    // Instantiate WASM with both WASI and pymode host imports
    this.wasmInstance = await WebAssembly.instantiate(wasmModule, {
      wasi_snapshot_preview1: this.createWasiImports(),
      pymode: hostImports,
    });
    this.wasmMemory = this.wasmInstance.exports.memory as WebAssembly.Memory;

    // Run Python
    const start = this.wasmInstance.exports._start as () => void;
    try {
      start();
      return { stdout: this.getStdout(), stderr: this.getStderr(), exitCode: 0 };
    } catch (e: any) {
      if (e.code !== undefined) {
        return { stdout: this.getStdout(), stderr: this.getStderr(), exitCode: e.code };
      }
      throw e;
    }
  }

  // ... createWasiImports() is the existing WASI shim from worker.ts
  // ... getStdout() / getStderr() collect from fd_write buffers
}
```

## Asyncify: Bridging Sync Python to Async JS

Binaryen's Asyncify instruments the WASM binary at build time so that async
host imports can suspend/resume the WASM call stack. This is the same approach
CF Python Workers (Pyodide) use — Pyodide compiles with Emscripten's Asyncify.

### How It Works

```
zig cc → python.wasm → wasm-opt --asyncify → python.wasm (instrumented)
```

At runtime, when Python calls an async host import (e.g. `tcp_recv`):

1. The JS import function returns a Promise
2. Asyncify unwinds the WASM call stack, saving all locals to a memory buffer
3. JS awaits the Promise (socket read, KV get, fetch, etc.)
4. When the Promise resolves, Asyncify rewinds the stack from the buffer
5. Execution resumes at the exact point it suspended, with the return value

From Python's perspective, `socket.recv()` is a normal synchronous call.
Single `_start()` invocation, zero re-execution.

### Build Command

```bash
wasm-opt -O2 --asyncify \
  --pass-arg=asyncify-imports@pymode.tcp_recv,pymode.http_fetch,pymode.kv_get,pymode.kv_put,pymode.kv_delete,pymode.r2_get,pymode.r2_put,pymode.d1_exec \
  --pass-arg=asyncify-ignore-indirect \
  python.wasm -o python.wasm
```

The `asyncify-imports@` list tells Binaryen which imports are async. Only call
paths that reach these imports get instrumented — everything else is untouched.
`asyncify-ignore-indirect` reduces overhead by not instrumenting indirect calls.

### JS Host Implementation

```typescript
// Async imports just return Promises — Asyncify handles the rest
const pymodeImports = {
  tcp_recv: async (connId, bufPtr, bufLen) => {
    const { value } = await conn.reader.read();  // real async I/O
    memory.set(value, bufPtr);
    return value.length;
  },
  http_fetch: async (urlPtr, urlLen, ...) => {
    const resp = await fetch(url, { method, headers, body });
    // ...
    return responseId;
  },
  // Sync imports return directly — no Promise, no suspension
  tcp_connect: (hostPtr, hostLen, port) => { ... return connId; },
  tcp_send: (connId, dataPtr, dataLen) => { ... return dataLen; },
};

// AsyncifyRuntime wraps imports and handles unwind/rewind
const asyncify = new AsyncifyRuntime();
const wrapped = asyncify.wrapImports({ pymode: pymodeImports }, ASYNC_IMPORTS);
const instance = new WebAssembly.Instance(wasmModule, wrapped);
asyncify.init(instance);
await asyncify.callExport("_start");  // single call, handles all async ops
```

### Async Import Classification

| Host Import | Sync/Async | Why |
|-------------|-----------|-----|
| `tcp_connect` | Sync | `cloudflare:sockets` `connect()` returns synchronously |
| `tcp_send` | Sync | `writer.write()` buffers, doesn't need to await |
| `tcp_recv` | **Async** | Must await `reader.read()` |
| `tcp_close` | Sync | Cleanup, no await needed |
| `http_fetch` | **Async** | Must await `fetch()` + body |
| `http_response_status` | Sync | Reads from in-memory buffer |
| `http_response_read` | Sync | Reads from in-memory buffer |
| `http_response_header` | Sync | Reads from in-memory buffer |
| `kv_get` | **Async** | Must await `env.KV.get()` |
| `kv_put` | **Async** | Must await `env.KV.put()` |
| `kv_delete` | **Async** | Must await `env.KV.delete()` |
| `r2_get` | **Async** | Must await `env.R2.get()` |
| `r2_put` | **Async** | Must await `env.R2.put()` |
| `d1_exec` | **Async** | Must await `env.D1.prepare().all()` |
| `env_get` | Sync | Reads from env object |
| `console_log` | Sync | Calls console.log() |

### Size Impact

Asyncify adds ~30% binary size overhead due to stack instrumentation.
With `-O2` and `asyncify-ignore-indirect`, this is minimized:

| | Without Asyncify | With Asyncify |
|---|---|---|
| python.wasm | ~5.7MB | ~7.4MB |

Still well within CF's 10MB Worker limit.

## Wizer: Deploy-Time Memory Snapshots

Wizer pre-initializes WASM modules by running init code and snapshotting the
resulting linear memory. This eliminates CPython import overhead at runtime.

### Build Pipeline

```
zig cc → python.wasm → wizer → python-snapshot.wasm → deploy
```

### CPython Entry Point Split

```c
// Modules/main.c — modified for Wizer support

// Phase 1: Initialize interpreter + import stdlib
// Called by Wizer at build time. Memory is snapshotted after this returns.
__attribute__((export_name("__wizer_initialize")))
void __wizer_initialize(void) {
    // Minimal init — no user code
    Py_InitializeEx(0);

    // Pre-import commonly used modules so they're in the snapshot
    PyImport_ImportModule("sys");
    PyImport_ImportModule("os");
    PyImport_ImportModule("io");
    PyImport_ImportModule("json");
    PyImport_ImportModule("re");
    PyImport_ImportModule("collections");
    PyImport_ImportModule("functools");
    PyImport_ImportModule("itertools");
    PyImport_ImportModule("pathlib");
    PyImport_ImportModule("typing");
    PyImport_ImportModule("dataclasses");
    // Pre-import pymode shims
    PyImport_ImportModule("pymode.tcp");
    PyImport_ImportModule("pymode.http");
    PyImport_ImportModule("pymode.env");
}

// Phase 2: Run user code on the pre-initialized interpreter
// Called at request time. Interpreter is already warm from the snapshot.
__attribute__((export_name("__pymode_run")))
int __pymode_run(const char* code, int code_len) {
    PyObject* result = PyRun_StringFlags(code, Py_file_input, globals, locals, NULL);
    if (!result) {
        PyErr_Print();
        return 1;
    }
    Py_DECREF(result);
    return 0;
}
```

### Wizer Command

```bash
wizer python.wasm -o python-snapshot.wasm \
  --allow-wasi \
  --wasm-bulk-memory true \
  --init-func __wizer_initialize \
  --mapdir /stdlib::./lib/python3.13
```

### Cold Start Impact

| Phase | Without Wizer | With Wizer |
|-------|--------------|------------|
| Load WASM binary | ~5ms | ~5ms |
| Py_Initialize | ~10ms | 0ms (in snapshot) |
| Import stdlib | ~8ms | 0ms (in snapshot) |
| Import user deps | ~5ms | 0ms (if pre-imported) |
| Run user code | varies | varies |
| **Total cold start** | **~28ms + user deps** | **~5ms** |

## Threading: Each Thread = Separate DO

When Python calls `pthread_create`, the DO spawns a child DO (or Service
Binding Worker) to run the thread function in parallel.

```
┌──────────────────┐
│    PythonDO      │  (main thread)
│  python.wasm     │
│                  │
│  pthread_create ─┼──→ RPC ──→ ┌──────────────┐
│  pthread_create ─┼──→ RPC ──→ │ ThreadDO #1  │  (own 30s CPU)
│  ...             │            │ python.wasm  │
│  pthread_join  ←─┼──← RPC ──←│ runs fn(arg) │
│                  │            └──────────────┘
│  pthread_join  ←─┼──← RPC ──←┌──────────────┐
│                  │            │ ThreadDO #2  │
└──────────────────┘            └──────────────┘
```

Each ThreadDO:
- Gets its own 30s CPU budget, 128MB memory
- Runs a copy of python.wasm with the thread function
- Receives serialized arguments via RPC (Uint8Array)
- Returns serialized results via RPC

Limitations:
- No shared mutable memory (each DO has its own WASM linear memory)
- Only embarrassingly parallel workloads (map, independent I/O)
- 32 max fan-out per request chain (service binding limit)
- Arguments/results must be serializable (no pointers, no shared objects)

## wrangler.toml

```toml
name = "pymode"
main = "src/worker.ts"
compatibility_date = "2024-04-03"

[limits]
cpu_ms = 30000

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]

[durable_objects]
bindings = [
  { name = "PYTHON_DO", class_name = "PythonDO" },
]

[[migrations]]
tag = "v2"
new_classes = ["PythonDO"]
deleted_classes = ["TcpPoolDO"]

[vars]
# Environment variables accessible via pymode.env.get_env()
```

## Implementation Order

### Phase 1: Host imports + Asyncify (DONE)

**Goal**: Python calls `pymode_tcp_recv()` as a WASM import. Asyncify
suspends/resumes the WASM stack for async ops. Zero re-execution.

1. Define `pymode` WASM import namespace in C header (`pymode_imports.h`)
2. Build CPython with the `pymode` imports linked (zig cc `-Wl,--allow-undefined`)
3. Post-process with `wasm-opt --asyncify` to instrument async call paths
4. JS provides `pymode.*` functions when instantiating WASM
5. Move `python.wasm` instantiation into PythonDO
6. Async imports (tcp_recv, http_fetch, kv_*, r2_*, d1_exec) return Promises
7. AsyncifyRuntime handles unwind/rewind transparently
8. Rewrite pymode Python modules to call host imports via `_pymode` C module

**Files:**
- `lib/pymode-imports/pymode_imports.h` — C declarations for pymode.* namespace
- `lib/pymode-imports/pymode_imports.c` — CPython extension module `_pymode`
- `worker/src/asyncify.ts` — Asyncify runtime (unwind/rewind/wrap)
- `worker/src/python-do.ts` — PythonDO class with all host imports
- `worker/src/worker.ts` — re-exports PythonDO
- `lib/pymode/tcp.py` — host imports with legacy fallback
- `lib/pymode/http.py` — host imports with legacy fallback
- `lib/pymode/env.py` — KV, R2, D1 access
- `scripts/build-phase2.sh` — compile pymode imports, asyncify pass
- `worker/wrangler.toml` — PythonDO binding

### Phase 2: Wizer deploy-time snapshots

**Goal**: 5ms cold starts.

1. Split CPython main into `__wizer_initialize` + `__pymode_run`
2. Add Wizer to build pipeline
3. Pre-import stdlib + pymode shims in snapshot
4. Measure cold start improvement

### Phase 3: Threading via child DOs

**Goal**: Real parallelism for `pthread_create`.

1. Implement ThreadDO class
2. Modify pthread shim to call host import `pymode_thread_create`
3. PythonDO spawns ThreadDO via RPC, passes serialized args
4. `pthread_join` awaits ThreadDO result via host import

## Comparison: PyMode vs CF Python Workers (Target State)

| | CF Python Workers | PyMode (target) |
|---|---|---|
| Runtime | Pyodide (Emscripten) | CPython (zig cc, WASI) |
| Binary size | ~20MB+ | ~7.4MB (with Asyncify) |
| Cold start | ~50ms (snapshot) | ~5ms (Wizer snapshot) |
| Async bridge | Asyncify (Emscripten) | Asyncify (Binaryen) |
| FFI to CF services | Pyodide FFI (JS ↔ Python) | Host imports (WASM ↔ JS) |
| TCP connections | `cloudflare:sockets` via FFI | `cloudflare:sockets` via host import |
| DB access | Direct (Hyperdrive, D1) | Direct (host imports for KV, R2, D1) |
| Package support | 280+ (dynamic loading) | Static profiles + zipimport |
| Threading | None (`asyncio.gather`) | Real parallelism (child DOs) |
| Portability | CF only (Emscripten) | Any WASI host (portable) |
| Interpreter reuse | Per-request (stateless) | Persistent in DO (warm) |
