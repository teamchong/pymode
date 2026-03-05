# Design: Full Package Support for PyMode

## Goal

Match Pyodide's ~280 supported packages, compiled with `zig cc -target wasm32-wasi`
instead of Emscripten. Ship as a 5.7MB CPython WASM binary (vs Pyodide's 20MB+)
that runs on Cloudflare Workers with our custom synchronous WASI shim.

## Current State

- CPython 3.13 compiles to `wasm32-wasi` via `zig cc -Os` = 5.7MB
- Runs on CF Workers with custom sync WASI shim (28ms cold start)
- stdlib: 51 pure Python modules embedded via `generate-stdlib-fs.sh`
- C extensions: **none** — `binascii`, `_sre`, `_json`, `_struct` all disabled
- Pyodide ships 280+ packages (154 pure Python, ~140 with C/Rust/Fortran extensions, 40 system libs)

## Architecture Difference: Pyodide vs PyMode

| | Pyodide | PyMode |
|---|---------|--------|
| Target | wasm32-emscripten | wasm32-wasi |
| Compiler | Emscripten (clang) | `zig cc` |
| Linking | Dynamic (`MAIN_MODULE` + `SIDE_MODULE`) | **Static** |
| Extension loading | `dlopen()` at runtime | Compiled into binary |
| Binary size | ~20MB base + lazy .so per package | Single binary, tree-shaken |
| Runtime | Browser JS + Emscripten runtime | WASI preview1 (our shim on CF) |

### Critical Implication: Static Linking

Pyodide loads extensions as `.so` files via Emscripten's `dlopen`. WASI has **no dlopen**.
Every C extension must be statically linked into `python.wasm` at build time.

This means we can't lazy-load individual packages. Instead, we build **profiles** —
pre-configured python.wasm binaries with different sets of extensions baked in.

## Package Categorization

### Tier 0: CPython Built-in Extensions (ship with every profile)

These are C modules that are part of CPython itself. Currently disabled in our build.

| Module | What it does | Blocked by |
|--------|-------------|-----------|
| `_struct` | `struct.pack/unpack` | `py_cv_module` disabled |
| `binascii` | hex/base64 encoding | `py_cv_module` disabled |
| `_json` | Fast JSON parse/stringify | `py_cv_module` disabled |
| `_sre` | Regex engine | `py_cv_module` disabled |
| `_hashlib` / `_sha*` / `_md5` | Hash functions | `py_cv_module` disabled |
| `_csv` | CSV parser | `py_cv_module` disabled |
| `math` / `cmath` | Math functions | Should already build |
| `_decimal` | Decimal arithmetic | `py_cv_module` disabled |
| `_datetime` | Fast datetime | `py_cv_module` disabled |
| `_collections` | deque, OrderedDict, etc | Should already build |
| `_functools` | lru_cache, reduce, etc | Should already build |
| `_operator` | itemgetter, attrgetter | Should already build |
| `_io` | Core I/O | Should already build |
| `_pickle` | Serialization | `py_cv_module` disabled |
| `_socket` | Networking | Not possible on WASI |
| `_ssl` | TLS | Not possible on WASI |
| `_ctypes` | FFI | Not possible on WASI |
| `zlib` | Compression | Needs zlib source |
| `_bz2` | Compression | Needs bzip2 source |
| `_lzma` | Compression | Needs liblzma source |
| `_sqlite3` | Database | Needs sqlite3 source |

**Action**: Remove `py_cv_module_*=n/a` lines from build-phase2.sh for modules
that compile cleanly with `zig cc`. This alone unblocks most of the 154 pure Python
packages and many C extensions that only need CPython's own C modules.

### Tier 1: Pure Python Packages (154 packages, zero build work)

These need **no compilation** — just `.py` files in the filesystem. Examples:
`click`, `requests`, `six`, `packaging`, `attrs`, `jinja2`, `pydantic`,
`beautifulsoup4`, `flask`, `fastapi`, `httpx`, `rich`, `tqdm`, etc.

**Action**: Extend `generate-stdlib-fs.sh` to also bundle third-party pure Python
packages. Or better: use a zip-based import loader (Python's `zipimport` is built-in).

**Delivery mechanism** (two options):
1. **Embedded zip**: Bundle as `site-packages.zip`, Python's `zipimport` reads it
2. **Fetch on demand**: Worker fetches package from R2/KV on first import via custom `importlib` finder

Option 2 is better for CF Workers (avoid bloating the 10MB worker bundle limit).

### Tier 2: C Extensions That Only Need CPython + libc (58 packages)

These compile with just `zig cc` — no external system libraries needed:

| Package | C files | Notes |
|---------|---------|-------|
| `regex` | 9 .c files | Python-compatible regex |
| `simplejson` | 1 .c file | `_speedups.c` |
| `ujson` | ~5 .c files | Ultra-fast JSON |
| `orjson` | Rust | Needs cross-compile toolchain |
| `msgpack` | 2 .c files | `_cmsgpack.c` |
| `markupsafe` | 1 .c file | `_speedups.c` |
| `pyyaml` | ~10 .c files | libyaml vendored |
| `bitarray` | 1 .c file | Pure C |
| `crcmod` | 1 .c file | CRC calculation |
| `mmh3` | 2 .c files | MurmurHash3 |
| `xxhash` | 1 .c file | xxHash |
| `coverage` | 1 .c file | Tracer |
| `peewee` | 1 .c file | `_speedups.c` |
| `frozenlist` | Cython-generated | Pure C after cythonize |
| `multidict` | Cython-generated | Pure C after cythonize |
| `yarl` | Cython-generated | Pure C after cythonize |
| `propcache` | Cython-generated | Pure C after cythonize |
| `aiohttp` | Cython-generated | Pure C + parser |
| `cytoolz` | Cython-generated | Pure C |

**Action**: Build these as `.a` static libraries and link into python.wasm.

### Tier 3: C Extensions Needing System Libraries (42 packages)

| Package | Needs | Library Size |
|---------|-------|-------------|
| `numpy` | libopenblas (BLAS/LAPACK) | ~2MB .a |
| `scipy` | numpy + libopenblas + f2c | ~8MB .a |
| `pandas` | numpy | ~3MB .a |
| `matplotlib` | freetype, libpng, zlib | ~1MB .a |
| `Pillow` | libjpeg, libpng, zlib, freetype, libtiff, libwebp | ~2MB .a |
| `cryptography` | libopenssl (or ring/rustls) | ~1.5MB .a |
| `lxml` | libxml2, libxslt | ~2MB .a |
| `h5py` | libhdf5 | ~3MB .a |
| `shapely` | libgeos | ~1.5MB .a |
| `scikit-learn` | numpy, scipy, libopenblas | via numpy/scipy |
| `sqlalchemy` | (pure Python core, C speedups optional) | minimal |
| `lz4` | lz4 (vendored) | ~50KB |
| `zstandard` | zstd (vendored) | ~300KB |
| `brotli` | brotli (vendored) | ~200KB |
| `cffi` | libffi | ~100KB .a |

**Action**: Cross-compile each system library to `wasm32-wasi` with `zig cc`.
Store pre-built `.a` archives and headers in a `sysroot/` directory.

### Tier 4: Rust Extensions (7 packages)

| Package | Rust crate |
|---------|-----------|
| `cryptography` | `ring` or `rustls` |
| `orjson` | `serde_json` |
| `polars` | `polars` |
| `tiktoken` | `tiktoken` |
| `rpds-py` | `rpds` |
| `css-inline` | `css-inline` |
| `nh3` | `ammonia` |

**Action**: Use `cargo build --target wasm32-wasip1` and link the resulting `.a`.
Rust's wasm32-wasip1 target is well-supported.

### Tier 5: Fortran Extensions (5 packages)

| Package | Fortran source |
|---------|---------------|
| `scipy` | BLAS/LAPACK routines |
| `healpy` | HEALPix |

**Action**: Use f2c (Fortran-to-C translator) as Pyodide does, then compile with `zig cc`.

### Not Portable to WASI (skip)

| Package | Why |
|---------|-----|
| `pygame-ce` | Needs display/audio hardware |
| `opencv-python` | Needs camera/display |
| `imgui-bundle` | Needs GPU/display |
| `pyxel` | Game engine, needs display |
| `zengl` | OpenGL |
| `RobotRaconteur` | Networking/hardware |

These are 6 packages out of 280. 97.8% coverage is achievable.

## Host Feature Bridging: WASI Shim to CF Workers APIs

This is the hardest problem. Static linking solves *compilation*. But packages
expect a real operating system at *runtime* — sockets, filesystem, threads,
signals, subprocesses. Our WASI shim must bridge each of these to CF Workers APIs.

### The Bridge Architecture

```
Python code -> CPython C API -> POSIX/libc call -> WASI syscall -> JS WASI shim -> CF Workers API
```

Every host feature falls into one of four categories:

| Category | Example | CF Workers Has | Bridge Strategy |
|----------|---------|----------------|-----------------|
| **Has equivalent** | HTTP requests, crypto, clock | `fetch()`, `crypto`, `Date` | Map WASI syscall to CF API |
| **Has partial equivalent** | TCP sockets, DNS | `cloudflare:sockets`, `dns` | Implement WASI socket via CF TCP |
| **Needs virtualization** | Filesystem writes, `/tmp` | No persistent FS | In-memory VFS in our shim |
| **Impossible** | fork/exec, signals, mmap | Nothing | Return ENOSYS, packages must cope |

### 1. Networking — The Critical Bridge

**The problem**: `requests.get("https://api.example.com")` calls `socket.connect()` ->
`_socket.socket()` -> WASI `sock_connect()`. Our shim currently returns ENOSYS.

**CF Workers has**: `fetch()` API and `cloudflare:sockets` (raw TCP).

**Two-layer solution**:

#### Layer 1: Python-level HTTP patching (like pyodide-http)

Intercept `urllib3` and `requests` at the Python layer before they touch sockets.
Install a custom `urllib3.HTTPAdapter` that calls back into JS via a WASM->JS bridge:

```python
# pymode_http.py — loaded at startup, patches urllib3
import urllib3

class PyModeHTTPResponse:
    """Wraps a JS fetch() Response as a urllib3-compatible response."""
    def __init__(self, status, headers, data):
        self.status = status
        self.headers = headers
        self._data = data

    def read(self, amt=None):
        if amt is None:
            return self._data
        chunk = self._data[:amt]
        self._data = self._data[amt:]
        return chunk

class PyModePoolManager:
    """Replaces urllib3.PoolManager — routes HTTP through JS fetch()."""
    def request(self, method, url, **kwargs):
        body = kwargs.get("body", None)
        headers = kwargs.get("headers", {})
        # Call into JS via imported WASM function
        result = _pymode_fetch(method, url, headers, body)
        return PyModeHTTPResponse(result.status, result.headers, result.body)

# Monkey-patch urllib3
urllib3.PoolManager = PyModePoolManager
```

The `_pymode_fetch` function is a WASM import that our JS shim provides:

```typescript
// In worker.ts — additional WASM imports beyond wasi_snapshot_preview1
const pymode_imports = {
    pymode_fetch(method_ptr, method_len, url_ptr, url_len, body_ptr, body_len, ret_ptr) {
        // Read method, url, body from WASM memory
        // Call globalThis.fetch() synchronously (CF Workers fetch is sync within handler)
        // Write response status + body back to WASM memory at ret_ptr
    }
};

// Provide both import namespaces to WASM:
const instance = new WebAssembly.Instance(pythonWasm, {
    wasi_snapshot_preview1: wasi.imports,
    pymode: pymode_imports,
});
```

**Why this works on CF but not in browsers**: CF Workers' `fetch()` is *synchronous*
within a request handler — it doesn't need `await` in the WASM->JS call path because
workerd suspends the isolate and resumes when the fetch completes. This is unlike
browsers where you'd need asyncify or SharedArrayBuffer+Atomics.

#### Layer 2: WASI socket implementation (for packages that use raw sockets)

For packages that bypass `urllib3` and use `socket` directly (database drivers,
MQTT clients, custom protocols), implement WASI `sock_*` syscalls via CF's TCP socket API:

```typescript
// In our WASI shim — replace the ENOSYS returns
sock_open(af: number, socktype: number, protocol: number, retPtr: number): number {
    const fd = nextFd++;
    pendingSockets.set(fd, { af, socktype, connected: false, buffer: [] });
    view().setUint32(retPtr, fd, true);
    return ESUCCESS;
},

sock_connect(fd: number, addrPtr: number, addrLen: number): number {
    const sock = pendingSockets.get(fd);
    if (!sock) return EBADF;
    const { hostname, port } = parseWasiSockaddr(mem(), addrPtr, addrLen);

    // Use CF's TCP socket API
    const tcpSocket = connect({ hostname, port });
    connectedSockets.set(fd, tcpSocket);
    sock.connected = true;
    return ESUCCESS;
},

sock_send(fd: number, iovsPtr: number, iovsLen: number, flags: number, retPtr: number): number {
    const socket = connectedSockets.get(fd);
    if (!socket) return EBADF;
    const data = gatherIovs(iovsPtr, iovsLen);
    const writer = socket.writable.getWriter();
    writer.write(data);
    writer.releaseLock();
    view().setUint32(retPtr, data.length, true);
    return ESUCCESS;
},

sock_recv(fd: number, iovsPtr: number, iovsLen: number, flags: number, retPtr: number): number {
    const socket = connectedSockets.get(fd);
    if (!socket) return EBADF;
    const reader = socket.readable.getReader();
    const { value, done } = reader.read(); // synchronous in CF Workers
    reader.releaseLock();
    if (done || !value) {
        view().setUint32(retPtr, 0, true);
        return ESUCCESS;
    }
    const written = scatterIovs(iovsPtr, iovsLen, value);
    view().setUint32(retPtr, written, true);
    return ESUCCESS;
},
```

**Packages this unlocks**: `psycopg2` (PostgreSQL), `pymysql`, `redis-py`,
`pymongo`, `paho-mqtt`, and any package using raw TCP.

**What CF Workers blocks**: UDP (`dgram`), listening sockets (no inbound),
connections to private networks/localhost, port 25 (SMTP).

### 2. Filesystem — Virtual FS with Write Support

**Current state**: Read-only in-memory FS from embedded stdlib.

**What packages need**:
- `tempfile.mktemp()` — write temp files
- `open("output.csv", "w")` — create files
- `pathlib.Path.mkdir()` — create directories
- `sqlite3.connect("data.db")` — database files
- `pickle.dump(obj, open("model.pkl", "wb"))` — binary writes

**Solution**: Extend our WASI shim's VFS to support writes:

```typescript
// Add write support to the existing file map
const writableFiles = new Map<string, Uint8Array>(); // path -> content

path_open(dirFd, dirflags, pathPtr, pathLen, oflags, ...): number {
    const pathStr = readString(pathPtr, pathLen);
    const fullPath = resolvePath(dirFd, pathStr);

    // O_CREAT flag set — create a new writable file
    if (oflags & 1) {  // __WASI_OFLAGS_CREAT
        const fd = nextFd++;
        writableFiles.set(fullPath, new Uint8Array(0));
        openFiles.set(fd, {
            path: fullPath,
            data: writableFiles.get(fullPath)!,
            offset: 0,
            isDir: false,
            writable: true,
        });
        view().setUint32(retPtr, fd, true);
        return ESUCCESS;
    }

    // Check writable files first, then read-only files
    const data = writableFiles.get(fullPath) || files[fullPath];
    // ... existing logic
},

fd_write(fd, iovsPtr, iovsLen, retPtr): number {
    if (fd === FD_STDOUT) { /* existing stdout logic */ }
    if (fd === FD_STDERR) { /* existing stderr logic */ }

    const file = openFiles.get(fd);
    if (!file || !file.writable) return EBADF;

    // Gather data from iovecs
    const data = gatherIovs(iovsPtr, iovsLen);

    // Grow the file buffer and write at current offset
    const newSize = Math.max(file.data.length, file.offset + data.length);
    if (newSize > file.data.length) {
        const grown = new Uint8Array(newSize);
        grown.set(file.data);
        file.data = grown;
        writableFiles.set(file.path, grown);
    }
    file.data.set(data, file.offset);
    file.offset += data.length;

    view().setUint32(retPtr, data.length, true);
    return ESUCCESS;
},

path_create_directory(dirFd, pathPtr, pathLen): number {
    const pathStr = readString(pathPtr, pathLen);
    const fullPath = resolvePath(dirFd, pathStr);
    dirChildren.set(fullPath, []);
    // Add to parent's children list
    const parent = fullPath.split("/").slice(0, -1).join("/");
    const name = fullPath.split("/").pop()!;
    const siblings = dirChildren.get(parent) || [];
    if (!siblings.includes(name)) siblings.push(name);
    dirChildren.set(parent, siblings);
    return ESUCCESS;
},

path_unlink_file(dirFd, pathPtr, pathLen): number {
    const fullPath = resolvePath(dirFd, readString(pathPtr, pathLen));
    writableFiles.delete(fullPath);
    delete files[fullPath];
    return ESUCCESS;
},
```

**Persistent storage bridge**: For packages that need data to survive across requests,
add a second preopen directory `/data` backed by CF KV or R2:

```typescript
// /data preopen — reads/writes go to CF KV
const FD_DATA_PREOPEN = 4;

// On path_open for /data/* paths:
async function readFromKV(key: string): Promise<Uint8Array> {
    const value = await env.PYMODE_KV.get(key, "arrayBuffer");
    return value ? new Uint8Array(value) : null;
}

// On fd_close for writable /data/* files:
async function writeToKV(key: string, data: Uint8Array): Promise<void> {
    await env.PYMODE_KV.put(key, data);
}
```

### 3. Threading — Single-threaded Execution

**The problem**: `numpy`, `scikit-learn`, `scipy` use `pthread_create()` for
parallelism. CF Workers run in a single-threaded V8 isolate.

**What Pyodide does**: Runs everything single-threaded. `pthread_create()` is
available only with SharedArrayBuffer+COOP/COEP headers, which most deployments
don't enable. Most Pyodide users run single-threaded and it works.

**Our implementation**: Compile CPython with `--without-pymalloc` (already done)
and without thread support. At the C level, provide a pthread implementation
where `pthread_create()` calls the thread function inline on the current thread.
This is the correct semantic for a single-threaded runtime — identical to how
Emscripten handles pthreads when SharedArrayBuffer is unavailable:

```c
// pymode_pthread.c — linked into python.wasm
#include <pthread.h>
#include <errno.h>

int pthread_create(pthread_t *thread, const pthread_attr_t *attr,
                   void *(*start_routine)(void *), void *arg) {
    // Execute the function immediately on the calling thread
    start_routine(arg);
    *thread = 1;  // non-zero = valid thread id
    return 0;
}

int pthread_join(pthread_t thread, void **retval) {
    // Already completed (ran inline)
    if (retval) *retval = NULL;
    return 0;
}

int pthread_mutex_init(pthread_mutex_t *m, const pthread_mutexattr_t *a) { return 0; }
int pthread_mutex_lock(pthread_mutex_t *m) { return 0; }
int pthread_mutex_unlock(pthread_mutex_t *m) { return 0; }
int pthread_mutex_destroy(pthread_mutex_t *m) { return 0; }
int pthread_cond_init(pthread_cond_t *c, const pthread_condattr_t *a) { return 0; }
int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) { return 0; }
int pthread_cond_signal(pthread_cond_t *c) { return 0; }
int pthread_cond_broadcast(pthread_cond_t *c) { return 0; }
int pthread_cond_destroy(pthread_cond_t *c) { return 0; }
```

OpenBLAS, numpy, and scipy all detect single-threaded mode and fall back to
sequential execution automatically. The math is identical, just not parallelized.

### 4. Signals — Not Available, Not Needed

**The problem**: `signal.signal()`, `signal.alarm()`, `SIGINT` handling.

**Reality**: No WASI-targeted Python package depends on signals for core functionality.
CPython itself uses signals for keyboard interrupt (`Ctrl+C`) and timeout handling.
On CF Workers there's no terminal and timeouts are handled by workerd's CPU limit.

**Implementation**: Already handled — our `config.site-wasi` sets
`ac_cv_func_sigaction=no`, `ac_cv_func_signal=no`, etc. CPython compiles without
signal support. The `signal` module imports but `signal.signal()` raises `OSError`.

### 5. Subprocesses — Not Available, Not Needed

**The problem**: `subprocess.run()`, `os.system()`, `os.popen()`.

**Reality**: No CF Worker can fork/exec. Already disabled via `ac_cv_func_fork=no`.
Packages that shell out (like `pip`) won't work, but they shouldn't — you don't
install packages at runtime on CF Workers. Packages that use subprocess as a
fallback (like `hashlib` shelling out to `openssl`) work fine because the C
extension provides the fast path.

### 6. Time and Random — Already Working

**Current state**: Our WASI shim already implements:
- `clock_time_get` -> `Date.now()` (wall clock and monotonic)
- `random_get` -> `crypto.getRandomValues()` (CSPRNG)

These are sufficient for all packages. `datetime`, `time.time()`, `time.monotonic()`,
`random`, `secrets`, `uuid` all work through these two syscalls.

### 7. Environment Variables and Process Info

**Current state**: Our shim provides `environ_get`/`environ_sizes_get`.

**Extension needed**: Some packages check `os.cpu_count()`, `sys.platform`,
`platform.machine()`. These come from CPython's compile-time config:
- `sys.platform` = `"wasi"` (set at compile time)
- `os.cpu_count()` = `1` (single-threaded, return 1 via `sched_nprocessors()`)
- `platform.machine()` = `"wasm32"` (set at compile time)

### 8. Database Access — Via TCP Socket Bridge

**The problem**: `psycopg2`, `pymysql`, `sqlite3` need database connections.

**sqlite3**: Compiles directly into python.wasm (it's C, no OS deps beyond file I/O).
Uses our writable VFS. Database lives in memory or in `/data` backed by KV/R2.

**PostgreSQL/MySQL**: These use TCP. Once we implement the socket bridge (section 1,
layer 2), `psycopg2` and `pymysql` connect through CF's `cloudflare:sockets` API.
CF Workers can connect to any external database:
- Neon, Supabase, PlanetScale — via TCP socket bridge
- CF D1 — via native binding (needs Python wrapper)
- CF Hyperdrive — automatic connection pooling for PostgreSQL/MySQL

### 9. Async I/O — Event Loop Integration

**The problem**: `asyncio`, `aiohttp`, `fastapi` need an event loop.

**Reality**: CF Workers handle one request at a time (no concurrent I/O within a
single request). Python's `asyncio` event loop can still run — it just processes
one coroutine at a time.

**Implementation**: CPython's `asyncio` uses `selectors` which uses `select()`/`poll()`/
`epoll()`. None exist on WASI. But `asyncio` has a fallback: `ProactorEventLoop` on
Windows uses IOCP, not select. We provide a `PyModeEventLoop` that:

1. Runs coroutines to their next `await`
2. For `await fetch(...)`: calls our JS `fetch()` bridge synchronously
3. For `await asyncio.sleep(n)`: returns immediately (no point sleeping on CF)
4. For `await asyncio.gather(...)`: runs each coroutine sequentially

```python
# pymode_asyncio.py — custom event loop for CF Workers
import asyncio

class PyModeEventLoop(asyncio.SelectorEventLoop):
    """Event loop for CF Workers — all I/O is synchronous via WASI bridge."""

    def _run_once(self):
        # Process all ready callbacks
        while self._ready:
            handle = self._ready.popleft()
            handle._run()

    def create_connection(self, protocol_factory, host, port, **kwargs):
        # Use our WASI socket bridge instead of OS sockets
        sock = _pymode_socket_connect(host, port)
        transport = _PyModeTransport(sock)
        protocol = protocol_factory()
        protocol.connection_made(transport)
        return transport, protocol

# Install as default event loop
asyncio.set_event_loop_policy(PyModeEventLoopPolicy())
```

### Summary: What Each Package Category Needs

| Package Type | Compilation | Runtime Bridge |
|-------------|-------------|----------------|
| Pure Python (requests, flask) | None | HTTP patch (pymode_http.py) |
| C extension, compute (numpy, regex) | `zig cc` -> static link | None (pure computation) |
| C extension, I/O (psycopg2, redis) | `zig cc` -> static link | Socket bridge via `cloudflare:sockets` |
| C extension, FS (sqlite3, h5py) | `zig cc` -> static link | Writable VFS + KV/R2 bridge |
| C extension, threads (scipy, sklearn) | `zig cc` -> static link | Single-thread pthread |
| Async (aiohttp, fastapi) | `zig cc` -> static link | PyModeEventLoop |

### What Pyodide Bridges vs What We Bridge

| Feature | Pyodide Bridge | PyMode Bridge |
|---------|---------------|---------------|
| HTTP | `XMLHttpRequest` / browser `fetch()` | CF Workers `fetch()` |
| Sockets | Not supported (browser limitation) | CF `cloudflare:sockets` (TCP) |
| Filesystem | Emscripten MEMFS/IDBFS | Our WASI VFS + KV/R2 |
| Threads | SharedArrayBuffer (limited) | Single-thread inline execution |
| Async | Pyodide's `run_async` + JS Promise bridge | PyModeEventLoop + sync fetch |
| Crypto | Web Crypto API | CF Web Crypto API |
| Database | Not supported natively | Socket bridge to any TCP database |

**Key advantage over Pyodide**: We can do raw TCP via `cloudflare:sockets`. Pyodide
in the browser *cannot* make raw TCP connections at all. This means database drivers
(`psycopg2`, `pymysql`, `redis-py`) work on PyMode but not on Pyodide.


## Build System Design

### Directory Structure

```
pymode/
  sysroot/                      # Cross-compiled libraries for wasm32-wasi
    lib/
      libz.a
      libjpeg.a
      libpng.a
      libopenblas.a
      libssl.a
      libcrypto.a
      libxml2.a
      ...
    include/
      zlib.h
      jpeglib.h
      png.h
      cblas.h
      openssl/
      libxml/
      ...
  packages/                     # Package build recipes
    recipes.yaml                # Single file: package name -> build config
    patches/
      numpy/
        001-wasi-compat.patch
      scipy/
        001-f2c-fixes.patch
      ...
  scripts/
    build-sysroot.sh            # Build all system libraries
    build-extensions.sh         # Build all C extensions
    build-profile.sh            # Build a python.wasm profile
    build-phase2.sh             # (existing) CPython build
  profiles/
    minimal.txt                 # Just CPython built-ins
    web.txt                     # requests, flask, fastapi, jinja2, etc.
    data-science.txt            # numpy, pandas, scipy, matplotlib, sklearn
    full.txt                    # Everything
```

### recipes.yaml Format

```yaml
# Each package has a simple, declarative recipe
numpy:
  version: "2.2.5"
  source: pypi  # or git URL
  tier: 3
  system-deps: [libopenblas]
  build:
    backend: meson
    cross-file: numpy-wasi.ini
    env:
      NPY_BLAS_LIBS: "-L${SYSROOT}/lib -lopenblas"
  patches:
    - 001-wasi-compat.patch

simplejson:
  version: "3.19.2"
  source: pypi
  tier: 2
  build:
    # Default: python setup.py build_ext, compile .c files with zig cc
    c-files: ["_speedups.c"]

regex:
  version: "2024.4.16"
  source: pypi
  tier: 2
  build:
    c-files: ["_regex.c", "_regex_unicode.c"]
```

### System Library Build Script (`build-sysroot.sh`)

Each library follows the same pattern:

```bash
build_lib() {
    local name=$1 version=$2 url=$3

    cd /tmp && curl -L "$url" | tar xz
    cd "${name}-${version}"

    # Configure with zig cc targeting wasm32-wasi
    CC="zig cc -target wasm32-wasi" \
    AR="zig ar" \
    RANLIB="zig ranlib" \
    CFLAGS="-Os -fPIC" \
    ./configure --host=wasm32-wasi --prefix="$SYSROOT" --enable-static --disable-shared

    make -j$(nproc) && make install
}

# Priority order (dependency chain)
build_lib zlib      1.3.1  "https://zlib.net/zlib-1.3.1.tar.gz"
build_lib libpng    1.6.43 "https://download.sourceforge.net/libpng/libpng-1.6.43.tar.gz"
build_lib libjpeg   9f     "https://www.ijg.org/files/jpegsrc.v9f.tar.gz"
build_lib freetype  2.13.2 "https://download.savannah.gnu.org/releases/freetype/freetype-2.13.2.tar.gz"
build_lib openssl   3.2.1  "https://www.openssl.org/source/openssl-3.2.1.tar.gz"
build_lib libffi    3.4.6  "https://github.com/libffi/libffi/releases/download/v3.4.6/libffi-3.4.6.tar.gz"
# ... etc
```

`zig cc` handles cross-compilation natively — no need for WASI SDK or Emscripten ports.
This is our key advantage over Pyodide's build system.

### Extension Build Pipeline

For each C extension package:

1. **Download**: Fetch sdist from PyPI
2. **Patch**: Apply `patches/<package>/*.patch` if any
3. **Cythonize** (if needed): Run Cython on `.pyx` files using host Python
4. **Compile**: `zig cc -target wasm32-wasi -Os -I$SYSROOT/include -c *.c`
5. **Archive**: `zig ar rcs lib<package>.a *.o`
6. **Register**: Add to the extension registry for the linker

### Profile Linker (`build-profile.sh`)

```bash
#!/usr/bin/env bash
# Build a python.wasm with a specific set of extensions
PROFILE=$1  # e.g. "data-science"

# Read profile to get list of packages
PACKAGES=$(cat "profiles/${PROFILE}.txt")

# Collect all .a files and init functions
LINK_LIBS=""
INIT_TABLE=""
for pkg in $PACKAGES; do
    LINK_LIBS="$LINK_LIBS -L packages/build/$pkg -l$pkg"
    # Each extension registers via PyInit_<module>
    INIT_TABLE="$INIT_TABLE {\"$pkg\", PyInit_$pkg},"
done

# Generate _pymode_extensions.c with frozen module table
cat > _pymode_extensions.c << EOF
#include "Python.h"
static struct _inittab _pymode_builtins[] = {
    $INIT_TABLE
    {NULL, NULL}
};
void pymode_register_extensions(void) {
    PyImport_ExtendInittab(_pymode_builtins);
}
EOF

# Compile and link into python.wasm
zig cc -target wasm32-wasi -Os -c _pymode_extensions.c \
    -I$CPYTHON_DIR/Include -I$BUILD_DIR

# Re-link python.wasm with all extensions
# (modify CPython's Makefile to add our libs to LDFLAGS)
cd $BUILD_DIR
make LDFLAGS="$LDFLAGS $LINK_LIBS -l_pymode_extensions" python.wasm
```

### The `_inittab` Approach (How Static Extensions Work)

CPython supports statically linked extensions via `PyImport_ExtendInittab()`.
This is already used by CPython's own built-in modules. We extend the table:

```c
// This is called before Py_Initialize()
extern PyObject* PyInit_numpy(void);
extern PyObject* PyInit__speedups(void);  // simplejson

static struct _inittab extensions[] = {
    {"numpy", PyInit_numpy},
    {"simplejson._speedups", PyInit__speedups},
    {NULL, NULL}
};

// In our WASI entry point (before _start calls Py_Main):
PyImport_ExtendInittab(extensions);
```

The `.py` files for each package are still loaded from the filesystem (embedded or fetched).
Only the C acceleration modules are statically linked.

## Profile Sizes (Estimated)

| Profile | Extensions | python.wasm Size | + Stdlib/Packages |
|---------|-----------|------------------|-------------------|
| `minimal` | CPython built-ins only | ~6MB | + 200KB stdlib |
| `web` | + markupsafe, ujson, pyyaml, multidict, yarl, aiohttp | ~6.5MB | + 2MB packages |
| `data-science` | + numpy, scipy, pandas, matplotlib | ~15MB | + 5MB packages |
| `full` | Everything | ~25MB | + 10MB packages |

The `minimal` and `web` profiles fit in CF's 10MB worker limit.
`data-science` needs CF's paid plan (25MB limit) or module splitting.

## Handling the 10MB CF Worker Limit

For large profiles exceeding 10MB:
1. **Lazy WASM loading**: Store heavy `.wasm` modules in R2, fetch on first import
2. **Profile splitting**: Separate numpy.wasm, scipy.wasm loaded via `WebAssembly.instantiate`
3. **Module streaming**: Use CF's `WebAssembly.compileStreaming` from R2

But for MVP, the `minimal` (6MB) and `web` (6.5MB) profiles work as-is.

## Implementation Plan

### Phase 0: Extend WASI Shim — Writable FS + Networking (3-5 days)

**Goal**: Our WASI shim becomes a full runtime, not just a read-only FS.

1. Add writable file support to the VFS (path_open with O_CREAT, fd_write to files,
   path_create_directory, path_unlink_file)
2. Add the `pymode` WASM import namespace with `pymode_fetch` for HTTP
3. Write `pymode_http.py` that patches `urllib3.PoolManager` to use `pymode_fetch`
4. Implement WASI `sock_*` syscalls backed by `cloudflare:sockets` for raw TCP
5. Add `/data` preopen backed by CF KV for persistent storage
6. Write `pymode_pthread.c` for single-thread pthread semantics
7. Test: `requests.get("https://httpbin.org/get")` returns data
8. Test: `open("/tmp/test.txt", "w").write("hello")` then read it back
9. Test: `psycopg2.connect(...)` to a Neon PostgreSQL database

This must come BEFORE enabling packages — packages that compile will
crash at runtime without these bridges.

### Phase 1: Enable CPython Built-in C Modules (1-2 days)

**Goal**: Go from 0 C extensions to all CPython built-ins working.

1. Remove `py_cv_module_*=n/a` flags from `build-phase2.sh` for:
   - `binascii`, `_struct`, `_json`, `_sre`, `_sha256`, `_sha512`, `_md5`,
     `_hashlib`, `_csv`, `_decimal`, `_datetime`, `_pickle`, `_collections`,
     `_functools`, `_operator`, `math`, `cmath`, `_random`, `_bisect`,
     `_heapq`, `_statistics`, `array`, `_contextvars`, `_queue`
2. Fix any zig cc compilation issues (expect ~5 minor patches)
3. Test: `import json; json.dumps({"a": 1})` should use `_json` (fast path)
4. Test: `import re; re.match(r'\w+', 'hello')` should work (`_sre`)
5. Test: `import hashlib; hashlib.sha256(b'test').hexdigest()` should work

**This alone unblocks most pure Python packages** since they typically only
need CPython's built-in C modules.

### Phase 2: Package Delivery for Pure Python (2-3 days)

**Goal**: Load any pure Python package from PyPI.

1. Implement `zipimport`-based loader for `site-packages.zip`
2. Build a tool that downloads a wheel from PyPI, extracts `.py` files,
   adds them to the zip
3. Alternatively: custom `importlib.abc.Finder` that fetches from CF R2/KV
4. Test: `import requests`, `import flask`, `import jinja2`

### Phase 3: Sysroot — Cross-compile System Libraries (3-5 days)

**Goal**: Build the 10 most important system libraries as `wasm32-wasi` static archives.

Priority order (by number of packages that depend on them):
1. `zlib` (compression — many packages need it)
2. `libffi` (cffi — many packages need it)
3. `libssl` + `libcrypto` (cryptography, requests[security])
4. `libopenblas` (numpy, scipy, scikit-learn, pandas)
5. `libxml2` + `libxslt` (lxml)
6. `libjpeg` + `libpng` + `freetype` (Pillow, matplotlib)
7. `libgeos` (shapely)
8. `libhdf5` (h5py)
9. `libsqlite3` (already in CPython, just enable it)
10. `libyaml` (pyyaml C extension)

Each library: download, configure with zig cc, make, install to sysroot.

### Phase 4: Build Tier 2 C Extensions (3-5 days)

**Goal**: 58 packages with C code compile and link.

1. Start with the easiest: `markupsafe`, `simplejson`, `ujson`, `crcmod`, `mmh3`
2. Cython-based: `frozenlist`, `multidict`, `yarl`, `propcache`, `aiohttp`
   - Run `cython` on host to generate `.c`, then compile with `zig cc`
3. Larger: `regex`, `msgpack`, `pyyaml`, `bitarray`
4. Each package: compile `.c` files to `.o`, archive to `.a`, add to `_inittab`

### Phase 5: Build Tier 3 (numpy/scipy/pandas) (5-7 days)

**Goal**: The big three data science packages.

1. **numpy**: Meson build with cross-file for wasm32-wasi. Disable BLAS first
   (numpy works without it, just slower). Then add OpenBLAS.
2. **pandas**: Depends on numpy. Mostly Cython-generated C.
3. **scipy**: Hardest — needs f2c for Fortran code, OpenBLAS, many patches.
   Copy Pyodide's 18 patches as starting point.

### Phase 6: Rust Extensions (2-3 days)

**Goal**: `cryptography`, `orjson`, `polars`, `tiktoken` work.

1. Set up `cargo` with `wasm32-wasip1` target
2. Build each crate, extract `.a`
3. Link with Python C bindings (PyO3 supports wasm32-wasip1)

### Phase 7: Profiles and Packaging (2-3 days)

**Goal**: Users can choose a profile and get a working `python.wasm`.

1. Build the profile system
2. Create pre-built profiles: `minimal`, `web`, `data-science`
3. CI pipeline to rebuild on package updates
4. npm package or direct download for each profile

## Avoiding the Endless Loop

The key risk is: each package has unique build quirks, leading to an infinite
stream of one-off fixes. Here's how we prevent that:

### 1. Steal From Pyodide

Pyodide has already solved every build issue for every package. Their
`meta.yaml` files contain the exact patches, environment variables, and
build scripts needed. We don't need to rediscover these — just translate
from Emscripten flags to zig cc flags.

Translation table:
| Emscripten | zig cc wasm32-wasi |
|------------|-------------------|
| `-s SIDE_MODULE=2` | (not needed, static linking) |
| `-s USE_ZLIB` | `-L$SYSROOT/lib -lz` |
| `-s USE_FREETYPE=1` | `-L$SYSROOT/lib -lfreetype` |
| `embuilder build --pic libjpeg` | (pre-built in sysroot) |
| `-fwasm-exceptions` | `-fwasm-exceptions` (zig cc supports this) |
| `-sSUPPORT_LONGJMP=wasm` | (zig handles this natively) |
| `MAIN_MODULE=1` / dynamic linking | `_inittab` static registration |

### 2. Automate the Build

The `recipes.yaml` + `build-extensions.sh` pipeline means adding a new
package is a 5-line YAML entry, not a custom script. The common cases
(single .c file, Cython package, meson package) are handled by the build
system automatically.

### 3. Test Matrix

CI runs import tests for every package in every profile:

```bash
# For each package in the profile:
python.wasm -c "import $package; print($package.__version__)"
```

If a package breaks, CI catches it immediately.

### 4. Incremental Delivery

We don't need all 280 packages on day 1. The 80/20 rule applies:
- Phase 1 (CPython built-ins) unblocks ~154 pure Python packages
- Phase 2 (pure Python delivery) makes them actually usable
- Phase 3-4 (sysroot + Tier 2) adds the 58 most common C extensions
- That's 212 packages (76% coverage) before touching numpy/scipy

## Open Questions

1. **WASI threads**: Some packages (numpy, scikit-learn) benefit from threading.
   WASI preview2 has threads, but CF Workers are single-threaded. Do we implement
   `pthread_create` to run sequentially (call the function inline on the same thread),
   or disable threading entirely?
   → **Proposal**: Single-threaded pthread implementation (same as Pyodide's approach).

2. **setjmp/longjmp**: Several C libraries use `setjmp/longjmp` for error
   handling. Zig's wasm32-wasi target supports this via Wasm exceptions.
   Need to verify all libraries compile cleanly with `-fwasm-exceptions`.
   → **Test**: Compile zlib, libpng with zig cc and verify.

3. **Filesystem for large packages**: numpy alone has 30MB of `.py` files.
   We can't embed this in the worker bundle. Must use lazy loading from R2/KV.
   → **Proposal**: `importlib.abc.Finder` that fetches from R2, caches in memory.

4. **Package version pinning**: Pyodide pins exact versions. Should we match
   their pins exactly, or use latest?
   → **Proposal**: Match Pyodide's pins initially for compatibility, diverge later.

5. **Binary size budget**: The `minimal` profile at 6MB is fine. But
   `data-science` at ~15MB exceeds CF's free tier (10MB). Do we optimize
   harder or accept the paid tier requirement?
   → **Proposal**: Optimize with `wasm-opt -Oz` + strip, target 10MB. If still
   over, split into base + lazy-loaded numpy.wasm.

## Success Criteria

1. `minimal` profile: all CPython built-in C modules work, <6.5MB
2. `web` profile: requests, flask, fastapi, jinja2, pyyaml, aiohttp — <8MB
3. `data-science` profile: numpy, pandas, scipy, matplotlib, sklearn — <15MB
4. 95% of Pyodide's package list supported (274/280)
5. Cold start on CF Workers: <100ms for minimal, <500ms for data-science
6. npm package with pre-built profiles: `npx pymode init --profile web`
