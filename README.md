# ZigPython

Python compiled to WebAssembly using Zig, with metal0's Zig runtime replacing C extensions.

## What

- CPython compiled to `wasm32-wasi` using `zig cc` (no Emscripten, no WASI SDK)
- C extension modules progressively replaced with metal0's Zig implementations
- Target: Cloudflare Workers with <10MB WASM, <200ms cold start

## Why

Pyodide (Emscripten-based) is 20MB+, slow cold starts, requires special infrastructure.
CPython already has tier 2 `wasm32-wasi` support since 3.13. `zig cc` is a drop-in for clang.
Metal0 has 300+ Zig stdlib modules that can replace CPython's C extensions.

## Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | CPython WASI build (WASI SDK) | Done (28MB, 17/17 tests pass) |
| 2 | Replace WASI SDK with zig cc | In Progress |
| 3 | Replace C extensions with Zig | Planned |
| 4 | Cloudflare Workers integration | Planned |

## Quick Start

```bash
# Prerequisites: python3, wasmtime, WASI SDK (phase 1) or zig (phase 2+)

# Phase 1: Build with WASI SDK
./scripts/build-phase1.sh

# Test
./scripts/test.sh

# Phase 2: Build with zig cc
./scripts/build-phase2.sh
```

## Architecture

```
zigpython/
├── cpython/                    # CPython 3.13 source (git submodule)
├── patches/                    # Patches for zig cc compatibility
├── zig-modules/                # Zig replacements for C extensions
│   ├── _json/                  # SIMD JSON parser from metal0
│   ├── _sre/                   # Zig regex engine from metal0
│   ├── _collections/           # Counter, defaultdict, deque
│   └── ...
├── bridge/                     # Cloudflare Workers JS bridge
├── scripts/                    # Build and test scripts
└── cli/                        # zigpy CLI tool
```

## Module Replacement Priority

| C Extension | Zig Replacement | Benefit |
|---|---|---|
| `_json` | metal0 SIMD json | Faster parse/encode |
| `_sre` | metal0 regex | Smaller binary |
| `_collections` | metal0 collections | Counter, defaultdict, deque |
| `math` | metal0 math | Smaller |
| `_datetime` | metal0 datetime | Full datetime in Zig |
| `itertools` | metal0 itertools | Zig itertools |
| `_functools` | metal0 functools | Zig functools |
| `_csv` | metal0 csv | Zig CSV parser |
| `_struct` | metal0 struct | Binary packing |
| `hashlib` | metal0 hashlib | No OpenSSL dependency |
