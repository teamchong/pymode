# PyMode

Tool for compiling C extensions as wasm Python modules. Runs on Cloudflare Workers and anywhere else wasm32-wasi runs.

> Personal experiment. Cloudflare's [Python Workers](https://blog.cloudflare.com/python-workers-advancements/) (Pyodide based) are the supported path for production Python on CF. They ship a much larger package catalog and their runtime is compiled into workerd, so it doesn't eat your 10 MiB worker bundle. If your packages are in Pyodide, use that.

## Where this is useful

You have a C extension that isn't in Pyodide's catalog. Maybe it's internal, proprietary, a custom codec, or just hasn't been packaged upstream yet. PyMode lets you write a small recipe and produce a wasm Python module from it.

For Rust extensions the picture is less interesting. PyO3's bridge between Python and Rust adds the same per call cost regardless of which runtime hosts it, so PyMode doesn't really win there. C extensions are where the value shows up because they go directly through CPython's C ABI without a PyO3 layer in between.

## Building a C extension

Write a recipe in `recipes/your-package.json`:

```json
{
  "name": "your-package",
  "version": "1.0.0",
  "pypi": "your-package",
  "type": "c",
  "sources": ["src/your_module.c"],
  "includes": ["src/"],
  "modules": {
    "your_package._native": "PyInit__native"
  },
  "python_packages": ["your_package/"],
  "depends": []
}
```

Then:

```bash
npx tsx scripts/build-recipe.ts your-package
npx tsx scripts/build-variant.ts your-package
```

You get a `python-your-package.wasm` you can ship.

## Other things that work

Pure Python on CF Workers with the usual handler pattern:

```python
from pymode.workers import Response

def on_fetch(request, env):
    return Response("Hello from PyMode!")
```

```bash
npx pymode init my-worker
cd my-worker
pymode deploy
```

About 40 pure Python packages have been tested (jinja2, httpx, requests, beautifulsoup4, pyyaml, click, attrs, fastapi, langchain-core, pydantic, etc.). They install at deploy time via `uv` and bundle into a zip that ships through the Workers Assets binding so it doesn't count against the 10 MiB worker cap.

Five C extension variants ship with the repo as examples of the recipe system. They work end to end on CF Workers:

| Variant | What's in it |
|---|---|
| numpy | multiarray_umath + random + fft, linalg stubbed (no LAPACK) |
| pandas | numpy + pandas 2.2.3, DataFrame and Series ops |
| pillow | PIL.Image with libjpeg-turbo + libpng + zlib statically linked |
| ujson | encode/decode |
| zstandard | compress/decompress |

These are demos. If you actually need pandas in production, use CF Python Workers. Their Pyodide based runtime gets pandas at ~1 second cold start via memory snapshots, and they ship scipy, sklearn, lxml, cryptography too. PyMode's pandas variant fits at 9.4 MB gz but pays ~25 seconds on a cold isolate (most of that is `import pandas` itself running in fresh Python).

## What doesn't work

The 10 MiB worker bundle cap is real. CPython itself is about 8 MB gzipped, so adding more variants gets tight fast. FastAPI plus SQLAlchemy plus pandas doesn't fit. Pyodide gets around this by being compiled into workerd, but that path isn't open to third parties.

scipy, scikit-learn, lxml, cryptography, orjson, cffi all need toolchains we don't have (Fortran for scipy, libxml2 for lxml, OpenSSL for cryptography, Rust runtime quirks for orjson). Cross compiling them is multi-week work per package. Not planned.

Cold isolate latency for variants is roughly 25 seconds. PythonDO with a 30 second alarm keeps the runtime warm in active regions, but new isolates in new regions still pay the cost. CF Python Workers' memory snapshots avoid this.

## Quick reference

```bash
pymode init <name>       # Scaffold a new project
pymode dev               # Local dev server (native Python)
pymode deploy            # Bundle and deploy to CF Workers
pymode add <package>     # Add a Python package dependency
pymode install           # Install all deps from pyproject.toml
```

## Architecture

```
CF Request
  Worker bundle (in 10 MiB cap):
    python.wasm (CompiledWasm, about 8 MB gz)
    user-files.ts (your .py files inlined)
    thin stubs for stdlib + site-packages

  Workers Assets (25 MiB per file, separate budget):
    stdlib-data.dat.gz       (gzipped JSON of CPython stdlib)
    extension-site-packages.zip.gz  (variant Python layer)
    site-packages.zip.gz     (your PyPI deps)

  Per request:
    Promise.all fetches and gunzips the assets, instantiates the wasm
    Variant deploys route through PythonDO with alarm based keep alive
    Pure Python deploys run inline in the worker isolate
    on_fetch(request, env) returns a Response
```

PythonDO's `storage.setAlarm(now + 30000)` keeps the instance alive past CF's eviction window. The wasm `persistentRunner` caches the instance so `import pandas` only runs once per DO lifetime.

## Building from source

Only needed if you're hacking on PyMode itself. End users get a prebuilt wasm per variant.

```bash
npx tsx scripts/build-phase2.ts          # CPython base
npx tsx scripts/generate-stdlib-fs.ts    # stdlib bundle
npx tsx scripts/build-variant.ts <name>  # specific variant
npm test
```

Prerequisites: python3, wasmtime, zig 0.15+, wasm-opt, optionally wizer.

## Status

The runtime works for what's documented. The project isn't under active feature development. PRs welcome for recipe additions if you have a C extension that fits the model. Don't expect quick replies.

Comparing honestly to CF Python Workers:

| | PyMode | CF Python Workers |
|---|---|---|
| Runtime location | in your worker bundle (8 MB gz) | compiled into workerd, free of bundle |
| Cold start (pandas) | ~25 s | ~1 s with memory snapshots |
| Package catalog | 5 variants plus ~40 pure Python | full Pyodide catalog |
| Custom C extensions | recipe based, you build them | upstream Pyodide PR required |
| Python flavor | upstream CPython 3.13 | Pyodide's CPython fork (Emscripten) |
| Self hostable | yes, runs on any wasm32-wasi runtime | CF only |

If you're picking a tool and your packages are in Pyodide, use CF Python Workers. If your C extension isn't, PyMode might save you a Pyodide upstream PR.

## License

MIT
