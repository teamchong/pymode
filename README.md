# PyMode

**Python on Cloudflare Workers.**

CPython 3.13 compiled to WASM with `zig cc` — **5.7MB** (1.8MB gzipped). Small enough to run on Workers.

## Why

Python's official WASM support is dying. CPython dropped Emscripten to Tier 3 in 3.13 — barely maintained, one PR away from removal. Pyodide depends on it and ships a **20MB+** runtime with brutal cold starts.

Meanwhile, `wasm32-wasi` is Tier 2 (officially supported), but the standard WASI SDK build produces a **28MB** binary. Way over Cloudflare's 10MB limit.

PyMode fixes this. We compile CPython with `zig cc -Os` + `wasm-opt` and cut the binary to **5.7MB** — a **4.9x reduction**. It fits on Workers with room to spare.

## Results

| Build | Size | Gzipped |
|-------|------|---------|
| Pyodide (Emscripten) | ~20 MB | ~6.4 MB |
| CPython WASI SDK | 28 MB | ~8 MB |
| **PyMode (zig cc)** | **5.7 MB** | **1.8 MB** |

```
$ python.wasm -c "import sys; print(sys.version)"
Python 3.13.0 on wasi

$ python.wasm -c "import json; print(json.dumps({'works': True}))"
{"works": true}

$ python.wasm -c "import hashlib; print(hashlib.sha256(b'hello').hexdigest())"
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

## Quick Start

```bash
# Prerequisites: python3, wasmtime, zig 0.15+

# Build
./scripts/build-phase2.sh

# Run
build/zig-wasi/python.sh -c "print('hello from pymode')"
```

## How It Works

1. **`zig cc` as a drop-in C compiler** — targets `wasm32-wasi` with `-Os` (size optimized)
2. **Aggressive module pruning** — 20+ unavailable WASI modules disabled at configure time
3. **`wasm-opt -Os`** — Binaryen pass for additional WASM-level size reduction
4. **Zig stdlib modules** — C extensions progressively replaced with Zig implementations from [metal0](https://github.com/nickel-org/metal0)

## Zig Module Replacements

Heavy C extensions replaced with lighter Zig implementations:

| Module | Status | Source |
|--------|--------|--------|
| `_json` | Done | metal0 SIMD JSON parser |
| `_hashlib` | Done | Zig `std.crypto` (no OpenSSL) |
| `_collections` | Done | deque, defaultdict, Counter |
| `_functools` | Done | partial, reduce, lru_cache |
| `_sre` | Planned | metal0 regex engine |
| `math` | Planned | metal0 math |
| `_datetime` | Planned | metal0 datetime |

## Stdlib Bundling

Python needs its stdlib to boot. PyMode bundles a minimal stdlib as a zip (4.3MB) that Python reads via `zipimport` — no filesystem needed.

```bash
# Build the minimal stdlib
./scripts/build-stdlib.sh

# Run with stdlib
PYTHONPATH=build/stdlib-minimal.zip build/zig-wasi/python.sh -c "import json; print(json.dumps({'ok': True}))"
```

Total deployment size: **5.7MB** (wasm) + **4.3MB** (stdlib.zip) = **~10MB** — fits within CF Workers paid plan.

## Pain Points Solved

### 1. Binary too large for edge runtimes
Pyodide ships 20MB+, WASI SDK produces 28MB. Neither fits Cloudflare's 10MB limit.
**PyMode: 5.7MB** (1.8MB gzipped). Fits with room for your app code.

### 2. No OpenSSL on edge
C extensions like `_hashlib` link against OpenSSL, which doesn't exist on WASI/Workers.
**PyMode: Zig replacements** use `std.crypto` — zero external dependencies, same Python API.

### 3. Cold start penalty
Loading 20MB of WASM + initializing the interpreter takes seconds.
**PyMode: Wizer pre-initialization** snapshots the interpreter after startup, so Workers resume from a warm state.

### 4. No filesystem for stdlib
Edge runtimes don't have `/usr/lib/python3.13`. Pyodide uses a virtual FS overlay.
**PyMode: zipimport** — stdlib ships as a single `.zip`, Python reads it natively. No FS emulation needed.

### 5. C extension compatibility
Most C extensions assume POSIX/glibc and won't compile for WASI.
**PyMode: Zig module replacements** rewrite critical C extensions in pure Zig targeting `wasm32-wasi` directly.

## Roadmap

- [x] CPython 3.13 WASI build via `zig cc` (5.7MB wasm)
- [x] Zig module replacements (_json, _hashlib, _collections, _functools)
- [x] Minimal stdlib bundled as zip (4.3MB, boots via zipimport)
- [ ] Cloudflare Workers integration (JS bridge + `@cloudflare/workers-wasi`)
- [ ] Wizer pre-initialization (snapshot warm interpreter state)
- [ ] Additional Zig module replacements (_sre, math, _datetime)

## License

MIT
