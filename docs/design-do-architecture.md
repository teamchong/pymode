# Design: Durable Object Architecture for PyMode

## Problem

Cloudflare Workers have hard limits that constrain PyMode:

| Limit | Value | Impact |
|-------|-------|--------|
| CPU time per request | 30s (paid), 10ms (free) | Long-running Python scripts timeout |
| Memory per isolate | 128MB shared | CPython WASM + JS heap must fit |
| Concurrent connections | 6 per invocation | Can't open many DB connections |
| Re-execution trampoline | N rounds for N recv() calls | Each DB query = full Python restart |

The trampoline is especially expensive for database protocols. A PostgreSQL
`SELECT 1` requires ~5 trampoline rounds (SSL negotiation, auth, query, result,
ready-for-query). Each round re-executes the entire Python program from scratch.

## Proposed Architecture

Map each logical concern to a Durable Object:

```
                    ┌─────────────────┐
     HTTP request → │  PyMode Worker  │ (stateless entry point)
                    │  (WASI shim)    │
                    └────────┬────────┘
                             │ RPC
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ TcpPoolDO  │  │ ComputeDO  │  │ ComputeDO  │
     │ "pg:5432"  │  │ "thread-1" │  │ "thread-2" │
     │            │  │            │  │            │
     │ persistent │  │ runs WASM  │  │ runs WASM  │
     │ TCP socket │  │ (30s CPU)  │  │ (30s CPU)  │
     └────────────┘  └────────────┘  └────────────┘
```

### Three DO Classes

**1. PyModeWorker (stateless Worker — NOT a DO)**
- Entry point. Receives HTTP request, loads python.wasm, starts execution.
- On `pthread_create` → fans out to ComputeDO via RPC.
- On TCP `connect()` → routes to TcpPoolDO via RPC.
- Remains the orchestrator; does not hold connections or threads.

**2. TcpPoolDO (persistent TCP connections)**
- One DO instance per `host:port` pair (e.g., `"db.example.com:5432"`).
- Holds the `cloudflare:sockets` TCP connection as in-memory state.
- Connection persists across multiple RPC calls while the DO is alive (70-140s idle timeout).
- Exposes RPC methods: `connect()`, `send(data)`, `recv(bufsize)`, `close()`.
- No more trampoline replay — the connection is real and stateful.

**3. ComputeDO (parallel thread execution)**
- One DO instance per `pthread_create` call.
- Each gets its own 30s CPU budget, 128MB memory.
- Runs a subset of the WASM module (the thread function + its closure).
- Reports results back to PyModeWorker via RPC return value.

## How TCP Changes

### Before (trampoline replay)

```
Round 1: Python runs → connect() → send(SSL) → recv() → EXIT 254
         JS replays: connect, send, recv → writes response to VFS
Round 2: Python runs → connect() → send(SSL) → recv(cached) → send(auth) → recv() → EXIT 254
         JS replays: connect, send, recv(skip), send, recv → writes response
Round 3: ... (5+ rounds for a single query)
```

Each round re-executes the entire Python program. For a script that does 10 DB
queries, each with 5 handshake rounds, that's 50 full re-executions.

### After (TcpPoolDO)

```
Python runs → connect() → RPC to TcpPoolDO.connect("db:5432")
           → send(SSL)  → RPC to TcpPoolDO.send(data)   [~0ms if same colo]
           → recv()      → RPC to TcpPoolDO.recv(8192)   [waits for real data]
           → send(auth)  → RPC to TcpPoolDO.send(data)
           → recv()      → RPC to TcpPoolDO.recv(8192)
           → ... continues without restart
```

Zero re-executions. The Python program runs once, start to finish. Each socket
operation is a synchronous-looking RPC call.

### The Async Bridge Problem

Python (in WASM) is synchronous. RPC calls are async (return Promises). There
are three ways to bridge this:

**Option A: Asyncify / Stack Switching (ideal but complex)**
Compile CPython with Asyncify or use JSPI (JavaScript Promise Integration).
When Python calls `recv()`, the WASM stack is suspended, the Promise resolves,
and the stack resumes. This is what Pyodide does with Emscripten's Asyncify.

- JSPI is available in V8 (Chrome 123+, workerd likely supports it).
- Requires `--experimental-wasm-stack-switching` or the newer standardized JSPI.
- Zero overhead when not suspended. ~50us per suspend/resume.
- **Status**: workerd has V8, JSPI proposal is Phase 4. Worth investigating.

**Option B: Single-operation trampoline (pragmatic)**
Keep the exit-254 trampoline but make each round do only ONE operation via
TcpPoolDO, instead of replaying the entire conversation:

```
Round 1: Python → connect("db:5432") → EXIT 254
         JS → TcpPoolDO.connect() → re-run Python
Round 2: Python → connect(cached) → send(SSL) → EXIT 254
         JS → TcpPoolDO.send() → re-run Python
Round 3: Python → ... → recv() → EXIT 254
         JS → TcpPoolDO.recv() → re-run Python
```

Still O(N) rounds, but each round is a single RPC call (not a full TCP replay).
And the TcpPoolDO holds the connection, so handshake state isn't lost.

**Option C: Batch operations (middle ground)**
Python records a batch of operations up to the first recv(), sends them all at
once, then exits. JS replays the batch on TcpPoolDO, gets the response, re-runs.

This reduces rounds to O(recv_count) instead of O(total_ops), which is what
the current trampoline already does. The improvement is that TcpPoolDO holds
the persistent connection, so no conversation replay is needed.

**Recommendation**: Start with Option B (simplest, works today), pursue Option A
(JSPI) as it becomes stable in workerd. Option C is the current behavior with
the benefit of persistent connections — this is the minimum viable change.

## How Threading Changes

### Before (single-threaded pthread shim)

```c
// pthread.c shim — runs function inline on calling thread
int pthread_create(pthread_t *thread, ..., void *(*fn)(void *), void *arg) {
    *thread = next_thread_id++;
    fn(arg);  // blocks the caller
    return 0;
}
```

Everything is serial. No parallelism possible.

### After (ComputeDO fan-out)

```
Python calls pthread_create(fn, arg)
  → pthread shim records: thread_id, fn_pointer, arg_pointer
  → writes thread request to VFS: /tmp/_pymode_threads/{thread_id}.json
  → EXIT 254

JS catches exit 254:
  → reads thread requests from VFS
  → for each thread:
      const doId = env.COMPUTE.idFromName(`thread-${id}`)
      const handle = env.COMPUTE.get(doId)
      promises.push(handle.execute(wasmModule, fnPtr, argPtr, memorySnapshot))
  → await Promise.all(promises)   // real parallelism!
  → write results to VFS
  → re-run Python

Python resumes:
  → pthread_join reads result from VFS
  → continues execution
```

Each ComputeDO gets:
- Its own 30s CPU budget (separate from the main Worker's)
- Its own 128MB memory
- A copy of the WASM module + relevant memory pages

### Data Serialization Between DOs

WASM linear memory cannot be shared between isolates. Thread arguments and
return values must be serialized:

```typescript
// In PyModeWorker, before fanning out:
const memorySnapshot = new Uint8Array(wasmInstance.exports.memory.buffer);
const threadArg = memorySnapshot.slice(argPtr, argPtr + argSize);

// In ComputeDO:
class ComputeDO extends DurableObject {
  async execute(wasmBytes: ArrayBuffer, fnPtr: number, arg: Uint8Array): Promise<Uint8Array> {
    const instance = await WebAssembly.instantiate(wasmBytes, imports);
    // Copy arg into new instance's memory
    new Uint8Array(instance.exports.memory.buffer).set(arg, argPtr);
    // Call the thread function
    instance.exports.__pymode_thread_entry(fnPtr, argPtr);
    // Return modified memory region
    return new Uint8Array(instance.exports.memory.buffer, resultPtr, resultSize);
  }
}
```

**Limitation**: Sharing full WASM memory (e.g., 40MB CPython heap) over RPC
is expensive. This works for compute tasks with small inputs/outputs (e.g.,
hash a chunk, parse a JSON blob) but not for tasks that need shared mutable
state across threads.

## CF Platform Constraints

### Durable Object Limits

| Resource | Limit |
|----------|-------|
| CPU time per request | 30s (configurable up to 5min) |
| Memory per isolate | 128MB shared with JS heap |
| Requests per DO | ~1,000/s soft limit |
| Storage per DO (SQLite) | 10GB per object |
| Storage per account | Unlimited (paid) |
| DO classes per account | 500 (paid) |
| Idle before hibernation | 10s (hibernatable) or 70-140s (non-hibernatable) |
| WebSocket message size | 32 MiB |

### RPC Characteristics

| Property | Value |
|----------|-------|
| Same-colo latency | ~0ms (same thread, same server) |
| Cross-colo latency | Network RTT (DO is pinned to first-access colo) |
| Promise pipelining | Yes — chain calls in 1 round trip |
| Max service binding calls | 32 per request |
| Max subrequests (paid) | 10,000 per invocation |

### TCP Socket Rules

- `cloudflare:sockets` `connect()` creates outbound TCP connections.
- Sockets must be created within handlers (fetch, alarm, etc.), not global scope.
- **In a DO**: sockets persist as in-memory state between RPC calls, as long as
  the DO isn't evicted. An active TCP connection prevents hibernation, so the DO
  stays alive for 70-140s after last use.
- 6 concurrent connections per invocation (but a DO can hold connections across
  multiple incoming RPC calls).

### Pricing

| Component | Included (paid plan) | Overage |
|-----------|---------------------|---------|
| Worker requests | 10M/month | $0.30/M |
| Worker CPU | 30M ms/month | $0.02/M ms |
| DO requests | 1M/month | $0.15/M |
| DO duration | 400K GB-s/month | $12.50/M GB-s |
| DO storage (writes) | 1M/month | $1.00/M |
| DO storage (reads) | — | $0.20/M |

**Cost model for a DB query** (Option B, single-op trampoline):
- A PostgreSQL `SELECT 1` = ~10 socket operations = 10 DO RPC calls
- Each RPC call = 1 DO request ($0.15/M) + some CPU ms
- 1000 queries/day = 10K DO requests/day = 300K/month → within free tier

**Cost model for threading** (ComputeDO fan-out):
- Each `pthread_create` = 1 DO instantiation + execution
- 4-thread parallel compute = 4 DO requests + 4 x CPU time
- If each thread runs 1s CPU: 4 x 1000ms = 4000ms → $0.00008

## TcpPoolDO Design

```typescript
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

export class TcpPoolDO extends DurableObject {
  private socket: Socket | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  async tcpConnect(host: string, port: number, tls: boolean): Promise<void> {
    const addr = `${host}:${port}`;
    this.socket = connect(addr, {
      secureTransport: tls ? "on" : "off",
    });
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
  }

  async tcpSend(dataBase64: string): Promise<void> {
    if (!this.writer) throw new Error("not connected");
    const data = Uint8Array.from(atob(dataBase64), c => c.charCodeAt(0));
    await this.writer.write(data);
  }

  async tcpRecv(bufsize: number): Promise<string> {
    if (!this.reader) throw new Error("not connected");
    const { value, done } = await this.reader.read();
    if (done || !value) return "";
    // Return base64-encoded response
    const bytes = value.slice(0, bufsize);
    return btoa(String.fromCharCode(...bytes));
  }

  async tcpClose(): Promise<void> {
    try { this.writer?.close(); } catch {}
    try { this.reader?.cancel(); } catch {}
    try { this.socket?.close(); } catch {}
    this.socket = null;
    this.reader = null;
    this.writer = null;
  }
}
```

### Connection Keepalive

The TcpPoolDO holds an open TCP socket as in-memory state. As long as the DO
receives at least one RPC call every 70-140 seconds, it stays alive in memory
and the connection persists. For database connection pooling:

1. **Active use**: Python makes queries → RPC calls keep the DO alive.
2. **Idle period**: After 70-140s with no calls, DO is evicted, socket closes.
3. **Next request**: New DO instance, new TCP connection (cold connect).

For long-lived connection pools, use the alarm API as a heartbeat:

```typescript
async tcpConnect(host: string, port: number, tls: boolean): Promise<void> {
  // ... connect ...
  // Keep alive: schedule alarm every 60s
  await this.ctx.storage.setAlarm(Date.now() + 60_000);
}

async alarm(): Promise<void> {
  if (this.socket) {
    // Reschedule to prevent eviction
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}
```

**Cost of keepalive**: 1 alarm/60s = 1440/day = ~43K/month DO requests per
connection. Well within free tier for a few connections.

## Python-Side Changes (pymode.tcp)

The TCP module needs a new mode: instead of writing ops to VFS and exiting,
it writes a single pending RPC request and exits. On re-run, it reads the
cached response.

```python
# pymode/tcp.py — DO mode

PENDING_RPC_PATH = "/stdlib/tmp/_pymode_tcp_rpc.json"
RESPONSE_DIR = "/stdlib/tmp/_pymode_tcp_responses"

class PyModeSocket:
    _ops_counter = 0  # global, resets on re-execution (correct)

    def connect(self, addr):
        op_id = PyModeSocket._ops_counter
        PyModeSocket._ops_counter += 1
        resp_path = f"{RESPONSE_DIR}/{op_id}"

        if os.path.exists(resp_path):
            return  # already connected in a previous round

        # Request the connection via RPC
        _request_rpc({
            "op": "connect",
            "connId": self._conn_id,
            "host": addr[0],
            "port": addr[1],
            "opId": op_id,
        })

    def send(self, data):
        op_id = PyModeSocket._ops_counter
        PyModeSocket._ops_counter += 1
        resp_path = f"{RESPONSE_DIR}/{op_id}"

        if os.path.exists(resp_path):
            return len(data)  # already sent

        _request_rpc({
            "op": "send",
            "connId": self._conn_id,
            "dataBase64": base64.b64encode(data).decode("ascii"),
            "opId": op_id,
        })

    def recv(self, bufsize):
        op_id = PyModeSocket._ops_counter
        PyModeSocket._ops_counter += 1
        resp_path = f"{RESPONSE_DIR}/{op_id}"

        if os.path.exists(resp_path):
            with open(resp_path, "rb") as f:
                data = json.load(f)
            return base64.b64decode(data["dataBase64"])[:bufsize]

        _request_rpc({
            "op": "recv",
            "connId": self._conn_id,
            "bufsize": bufsize,
            "opId": op_id,
        })


def _request_rpc(op):
    """Write a single RPC request and exit for JS to handle."""
    with open(PENDING_RPC_PATH, "w") as f:
        json.dump(op, f)
    sys.exit(254)
```

### JS Trampoline (DO mode)

```typescript
async function runPythonWithDO(
  wasmModule: WebAssembly.Module,
  env: Env,
  files: Record<string, Uint8Array>,
): Promise<WasiResult> {
  const writtenFiles = new Map<string, Uint8Array>();
  let opCounter = 0;

  // Map of connId → TcpPoolDO handle
  const connHandles = new Map<string, DurableObjectNamespace>();

  while (true) {
    const result = runWasm(wasmModule, files, writtenFiles);

    if (result.exitCode !== 254) return result;

    // Read pending RPC request
    const rpcData = writtenFiles.get("/stdlib/tmp/_pymode_tcp_rpc.json");
    if (!rpcData) return result; // no RPC pending, actual exit 254

    const op = JSON.parse(new TextDecoder().decode(rpcData));
    writtenFiles.delete("/stdlib/tmp/_pymode_tcp_rpc.json");

    // Get or create TcpPoolDO for this connection
    let doHandle = connHandles.get(op.connId);
    if (!doHandle && op.op === "connect") {
      const id = env.TCP_POOL.idFromName(`${op.host}:${op.port}`);
      doHandle = env.TCP_POOL.get(id);
      connHandles.set(op.connId, doHandle);
    }

    // Execute the RPC
    let response: any;
    switch (op.op) {
      case "connect":
        await doHandle!.tcpConnect(op.host, op.port, false);
        response = { ok: true };
        break;
      case "send":
        await doHandle!.tcpSend(op.dataBase64);
        response = { ok: true };
        break;
      case "recv":
        const data = await doHandle!.tcpRecv(op.bufsize);
        response = { dataBase64: data };
        break;
      case "close":
        await doHandle!.tcpClose();
        connHandles.delete(op.connId);
        response = { ok: true };
        break;
    }

    // Write response to VFS for Python to find on re-run
    const respPath = `/stdlib/tmp/_pymode_tcp_responses/${op.opId}`;
    const respBytes = new TextEncoder().encode(JSON.stringify(response));
    writtenFiles.set(respPath, respBytes);
  }
}
```

## wrangler.toml Configuration

```toml
name = "pymode-worker"
main = "src/worker.ts"
compatibility_date = "2024-12-01"

# Durable Object bindings
[durable_objects]
bindings = [
  { name = "TCP_POOL", class_name = "TcpPoolDO" },
  { name = "COMPUTE", class_name = "ComputeDO" },
]

# DO migrations
[[migrations]]
tag = "v1"
new_classes = ["TcpPoolDO", "ComputeDO"]
```

## Implementation Order

### Phase 1: TcpPoolDO (highest value, simplest)
1. Create `TcpPoolDO` class with `tcpConnect`, `tcpSend`, `tcpRecv`, `tcpClose`.
2. Modify JS trampoline to detect DO mode and route TCP ops to TcpPoolDO.
3. Update `pymode/tcp.py` to use single-op RPC pattern.
4. Test with PostgreSQL `SELECT 1` — should work in ~10 rounds (one per socket op)
   instead of ~50 rounds (full replay per recv).

### Phase 2: Connection reuse across requests
1. Add alarm-based keepalive to TcpPoolDO.
2. Name DOs by `host:port` so the same connection is reused.
3. Add connection health check (attempt read, reconnect if socket is dead).

### Phase 3: ComputeDO (threading)
1. Create `ComputeDO` class with `execute(wasmBytes, fnPtr, arg)`.
2. Modify pthread shim to write thread requests to VFS instead of inline exec.
3. JS catches exit 254 with thread requests, fans out via `Promise.all`.
4. Python reads results from VFS on re-run.

### Phase 4: JSPI investigation
1. Test if workerd supports `WebAssembly.Suspending` / `WebAssembly.Promising`.
2. If yes: wrap TcpPoolDO RPC calls as suspendable imports.
3. This eliminates the trampoline entirely — Python runs once, every RPC call
   suspends/resumes the WASM stack transparently.

## Tradeoffs and Risks

### Advantages
- **Persistent connections**: DB handshake happens once, not every request.
- **Real parallelism**: Each DO = separate CPU budget, separate memory.
- **Cost-effective**: DO requests are $0.15/M, much cheaper than Lambda.
- **No replay overhead**: TcpPoolDO eliminates conversation replay entirely.

### Risks
- **DO cold start**: First RPC to a new DO instance adds latency (~5-10ms).
  Mitigated by connection reuse (same `host:port` = same DO = warm).
- **Memory serialization**: Copying WASM memory for ComputeDO is expensive.
  Only viable for small-input/small-output compute tasks.
- **6 concurrent connections**: Each DO invocation can open 6 connections.
  For connection pools, each TcpPoolDO manages one connection; multiple DOs
  for multiple connections.
- **DO location pinning**: A DO is pinned to its first-access colo. If the
  user is in US-East and the DB is in EU-West, the DO is in US-East and TCP
  to the DB crosses the Atlantic. Consider naming DOs to hint at location.
- **No shared mutable state**: Threads in ComputeDOs cannot share memory.
  This breaks `threading.Lock`, shared queues, etc. Only embarrassingly
  parallel workloads benefit (data-parallel map, independent HTTP fetches).
- **32 service binding calls per request**: Limits fan-out to 32 threads max
  per incoming request. Sufficient for most Python threading use cases.

## Comparison: Before and After

| Metric | Trampoline (current) | TcpPoolDO | JSPI (future) |
|--------|---------------------|-----------|---------------|
| DB query rounds | 5-10 per query | 10 per query (1 per op) | 0 (no trampoline) |
| Python re-executions | 5-10 per query | 10 per query | 0 |
| Connection reuse | No (new each round) | Yes (DO in-memory) | Yes |
| Threading | Serial (inline) | Parallel (ComputeDO) | Parallel |
| Complexity | Low | Medium | High |
| CF dependency | Worker only | Worker + DO | Worker + DO + JSPI |
