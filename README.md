# PyMode (Experimental)

**Upstream CPython 3.13 on Cloudflare Workers** — `zig cc` → `wasm32-wasi`.

> Personal experiment, parked. Cloudflare's [Python Workers](https://blog.cloudflare.com/python-workers-advancements/) (Pyodide-based, with memory snapshots and packaged uv workflow as of 2026) are the supported path for production Python on CF and ship a much larger package catalog (their runtime is compiled into workerd itself, so it doesn't eat your 10 MiB bundle). PyMode stays interesting only where you specifically want upstream CPython, want to self-host the wasm runtime, or need a smaller-than-Pyodide deploy for narrow API workloads.

## What works

- Pure-Python deploys with `pymode deploy`: handler pattern, multi-file projects, KV/R2/D1 via direct WASM host imports.
- Variants for C-extension packages (statically linked, deployable end-to-end):
  - `numpy` (multiarray_umath + random + fft; linalg stubbed — no LAPACK)
  - `pandas` (numpy + pandas 2.2.3, ~9.4 MB gz bundle; DataFrame/Series ops, IO module structure present)
  - `pillow` (libjpeg-turbo + libpng + zlib statically linked)
  - `ujson`, `zstandard`
  - `pydantic-core` (pre-built wasm works; rebuild currently fails on a libc CLOCK_*_CPUTIME_ID symbol)
- ~40 pure-Python packages tested working (jinja2, httpx, requests, beautifulsoup4, pyyaml, click, attrs, fastapi, langchain-core, pydantic, …).
- Wizer-warmed memory snapshot per deploy → fast warm-isolate latency (75–200 ms).
- Workers Assets staging for `stdlib-data.dat`, `extension-site-packages.zip`, `site-packages.zip` — pulled out of the 10 MiB worker bundle so user code + deps have room.
- PythonDO with alarm-driven warm loop keeps the variant runtime warm in active regions.

## What doesn't work / isn't worth it

- **Cold-isolate latency for variants is ~25 s** (dominated by `import pandas` itself — same on native Python). DO + alarms reduce hit rate but can't eliminate it. CF Python Workers solves this with memory snapshots → ~1 s for fastapi + httpx + pydantic. If cold start matters, use them, not pymode.
- **10 MiB hard ceiling**: pandas + small pure-Python deps fits at 9.4 MB gz; FastAPI + SQLAlchemy + pandas does not. CF Python Workers gets around it by compiling Pyodide into workerd — not a path available to third parties. No `[[unsafe.bindings]]` / `compatibility_flags` / Worker Loader trick changes this for custom wasm.
- **scipy / scikit-learn / lxml / cryptography / orjson / cffi**: no variants. Cross-compiling Fortran (scipy), libxml2 (lxml), OpenSSL (cryptography) is multi-week work each. CF Python Workers ships these via Pyodide.
- **Single-isolate concurrency**: requests queue inside one wasm Instance. `pymode.parallel` spawns child DOs for explicit parallelism but it's opt-in.

## Quick start

```bash
npx pymode init my-worker
cd my-worker
pymode deploy
```

Your handler (`src/entry.py`):

```python
from pymode.workers import Response

def on_fetch(request, env):
    return Response("Hello from PyMode!")
```

For pandas:

```toml
# pyproject.toml
[project]
dependencies = ["pandas==2.2.3", "jinja2", "httpx"]

[tool.pymode]
main = "src/entry.py"
```

```python
# src/entry.py
import pandas as pd
from pymode.workers import Response
import json

def on_fetch(request, env):
    df = pd.DataFrame({"a": [1, 2, 3]})
    return Response(json.dumps({"sum": int(df["a"].sum())}))
```

`pymode deploy` auto-detects the pandas variant, stages the site-packages zips into Workers Assets, and routes requests through PythonDO so the runtime stays warm between requests.

## Architecture (current)

```
CF Request
  ├─ Worker (stateless, in-bundle):
  │    ├─ wasm CompiledWasm (python.wasm, 8 MB gz)
  │    ├─ user-files.ts (your .py files, inlined)
  │    └─ thin stubs for stdlib + site-packages
  └─ ASSETS binding (separate budget):
       ├─ stdlib-data.dat.gz       (~1.2 MB gz, 5 MB raw)
       ├─ extension-site-packages.zip.gz  (variant Python: pandas/numpy/…)
       └─ site-packages.zip.gz     (user's PyPI deps, fetched via uv)

Per request:
  Worker.fetch
    ├─ Promise.all([
    │    getPythonWasm(env),       // CompiledWasm import (cached per isolate)
    │    getStdlibBin(env),         // fetch + gunzip stdlib from Assets
    │    warmExtensionPackages(env),// fetch + gunzip variant Python from Assets
    │    warmSitePackages(env),     // fetch + gunzip user deps from Assets
    │  ])
    └─ Route:
         ├─ variant (extensionPackagesBin != null) → PythonDO (alarm-warmed)
         └─ pure-Python → inline runner (same isolate, no RPC hop)

PythonDO:
  - storage.setAlarm() every 30s keeps the DO instance alive past CF's
    ~70s eviction window
  - persistentRunner caches the wasm Instance across requests so
    `import pandas` only runs once per DO lifetime
```

## Building from source

Only needed if you're hacking on pymode itself. End users get a prebuilt
`python.wasm` per variant.

```bash
# Build CPython base wasm (zig cc)
npx tsx scripts/build-phase2.ts

# Generate stdlib bundle for worker
npx tsx scripts/generate-stdlib-fs.ts

# Build a variant
npx tsx scripts/build-variant.ts pandas

# Test
npm test
```

## When to use pymode vs CF Python Workers

| | pymode | CF Python Workers (Pyodide) |
|---|---|---|
| Runtime ships in your bundle | yes (8 MB gz) | no (compiled into workerd, free) |
| Cold-isolate latency for pandas | ~25 s | ~1 s (with memory snapshots) |
| Package catalog | 5 variants + ~40 pure-Python | full Pyodide catalog |
| C-extension wheels | per-recipe; you build them | provided |
| Python flavor | upstream CPython 3.13 | Pyodide's CPython fork (Emscripten) |
| Self-hostable | yes (works in any wasm32-wasi runtime) | CF-only |
| Use it for | narrow API endpoints, pandas-class transforms, niche cases where you want CPython exactly | most "real Python apps on CF" |

If you'd asked me a year ago, pymode had a clearer story. As of 2026 CF Python Workers' Pyodide path got significantly better and now wins for typical Python web apps on CF.

## Status

This repo is an experiment. The runtime works end-to-end for the variants
listed above. It is not under active feature development. PRs welcome
for variant recipes (e.g. lxml, scipy, cryptography) but the architectural
constraints — 10 MiB bundle, ~25s cold start — are not going away without
upstream CF support.

## License

MIT
