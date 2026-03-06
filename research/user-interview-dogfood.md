# PyMode User Interview: Dogfood with Production App

## Context

- **Date:** 2026-03-06
- **Method:** Port real Python patterns from a production FastAPI application (~25,000 lines, FastAPI + pydantic + numpy) to PyMode, run in workerd via vitest and wrangler dev
- **Goal:** Discover stdlib gaps, runtime issues, and package compatibility limits

---

## What was ported

| Pattern | Source | Modules Used | Result |
|---------|--------|-------------|--------|
| Template variable extraction | template parser | `re` | Works |
| Filter pipe parsing | template processor | `re`, `str` | Works |
| Conditional blocks (`{%if%}`) | template parser | `re` | Works |
| For-loop blocks (`{%for%}`) | template parser | `re` | Works |
| Text sanitization | utility module | `re` | Works |
| Whitespace normalization | utility module | `re` | Works |
| OOM error classification | error detection | `re` | Works |
| Schema validation | column type checking | built-ins | Works |
| .env file parsing | config loading | `re` | Works |
| Dataclass models | pydantic replacement | `dataclasses` | Works (after adding `inspect`) |
| LRU cache with TTL | caching layer | `collections.OrderedDict`, `time` | Works |
| XML parsing | template engine | `xml.etree.ElementTree` | Works (after adding `xml`) |
| UUID generation | request tracing | `uuid` | Works (after adding `uuid`) |
| HMAC authentication | API auth | `hmac`, `hashlib` | Works |
| URL building | API client | `urllib.parse` | Works |
| JSON response parsing | GraphQL responses | `json` | Works |
| Logging | structured logging | `logging` | Fails (requires `threading`) |
| pydantic import | model definitions | `pydantic` | Expected: MISSING |
| yaml import | config files | `yaml` | Expected: MISSING |
| Stdlib availability scan | 18 modules | `importlib` | Works |

**Result: 19/20 tests pass.** 1 known limitation (logging requires threading).

---

## Issues found and fixed

### Missing stdlib modules (fixed)

These were not in `generate-stdlib-fs.sh` BOOT_FILES:

| Module | Needed by | Impact |
|--------|-----------|--------|
| `inspect` | `dataclasses` | High — blocks the pydantic replacement |
| `dis`, `opcode`, `_opcode_metadata`, `ast` | `inspect` | Transitive deps |
| `xml/etree/*` | XML parsing | Medium — used by template engine |
| `uuid` | ID generation | Medium — common pattern |
| `logging/*` | Structured logging | Bundled but can't import (needs `threading`) |
| `_colorize` | `traceback` (CPython 3.13) | Boot chain dep |
| `importlib/_abc` | `importlib.util` | Boot chain dep |

### wrangler dev broken (fixed)

**Root cause:** `worker.ts` passed `WebAssembly.Module` and closure functions to PythonDO via DO RPC. These can't be structurally cloned in workerd.

**Fix:** Extracted WASI to shared `wasi.ts`. PythonDO now imports `python.wasm` and `stdlib-fs` directly. RPC methods accept only serializable params.

### WebAssembly.instantiate return type (fixed)

`WebAssembly.instantiate()` with a `Module` returns `Instance` directly, not `{ instance }`. PythonDO was destructuring wrong.

---

## What can't run from the source app

| Component | Lines | Why |
|-----------|-------|-----|
| FastAPI server | ~2,000 | Server framework, not applicable to Workers |
| Pydantic models | ~3,000 | Rust C extension (`pydantic-core`) |
| numpy/pandas compute | ~5,000 | Complex C/Fortran dependencies |
| Cloud SDKs | ~4,000 | Heavy SDK dependencies |
| Database/cache clients | ~2,000 | Network socket dependencies |

**~8-12% of the source app** (pure stdlib utilities) can run directly on PyMode.

---

## Key findings

### 1. `dataclasses` is the critical path
Without `inspect`, `dataclasses` doesn't work. Since pydantic can't run in WASM, `dataclasses` is the only viable model layer. This was the highest-impact fix.

### 2. `logging` is a hard gap
`logging` requires `threading`, which is fundamentally unavailable in single-threaded WASM. Users need to use `print()` for logging. Consider providing a `pymode.log` module as a threading-free alternative.

### 3. Multi-worker RPC is the answer for heavy packages
The 10MB bundle limit is per-worker. Heavy packages (numpy, pandas) should run in separate workers connected via Service Bindings. Added this to the architecture docs.

### 4. The stdlib bundle matters more than expected
Users don't just need `re` and `json`. Real-world code uses `dataclasses`, `xml.etree`, `uuid`, `hmac`, `urllib.parse` — all of which needed to be added. The bundle grew from ~70 to ~91 files (1.7MB → 2MB).

---

## Recommendations

1. **Add a `pymode.log` module** — threading-free logger that writes to stderr
2. **Bundle pydantic v1 pure-Python** — covers model definitions without Rust
3. **Bundle PyYAML pure-Python mode** — common config format
4. **Document the dataclasses pattern** — show it as the pydantic replacement in docs
5. **Add `csv`, `pathlib`, `pprint`** — commonly needed, pure Python, low cost
