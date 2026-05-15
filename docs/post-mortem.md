# PyMode Post-Mortem: What the Experiment Taught Me

PyMode was a personal experiment in running upstream CPython 3.13 on Cloudflare Workers. The runtime works as documented. The experiment is parked. The lessons are more useful than the code, so this document records them honestly.

## What I set out to test

> Can you ship vanilla CPython + arbitrary C extensions to Cloudflare Workers by compiling to `wasm32-wasi` with `zig cc`, instead of using Pyodide's Emscripten-based build?

The answer is yes, technically. Five C-extension variants (numpy, pandas, Pillow, ujson, zstandard) end up working end-to-end on CF Workers. About 40 pure-Python packages install and import.

## What I learned

### 1. The compile step is the wrong shape for AI-driven Python

The dominant Python workload in 2026 is an AI agent writing code one cell at a time: `write → exec → read result → write next`. That loop needs sub-second latency between cells and a stateful interpreter that preserves `globals()`.

PyMode's model is the opposite. You write `.py` files, bundle them into `user-files.ts`, deploy a Worker. For C-extension variants the build is measured in minutes. Even for pure Python it's a Wrangler deploy round-trip. There is no path from "agent emits a code string" to "runtime executes it against live session state" that doesn't go through a compile-and-deploy cycle.

The right shape for agent-driven Python is a stateful REPL session exposed over MCP — `POST /exec { code }` → result, with interpreter state preserved across calls. PyMode's `on_fetch(request, env)` entry point (`lib/pymode/_handler.py:107-111`) is shaped for request handling, not REPL exec. The whole project is on the wrong side of that split.

### 2. The wasm32-wasi vs wasm32-emscripten choice at the bottom of the stack determined the product shape at the top

Pyodide targets `wasm32-emscripten` and has `dlopen()`. C extensions load as `.so` files at runtime. The base interpreter is small; packages are lazy.

PyMode targets `wasm32-wasi`. WASI has no `dlopen`. Every C extension must be statically linked into `python.wasm` at build time. That forces a *variant profile* model: one prebuilt wasm per `{numpy}`, `{numpy, pandas}`, `{Pillow}` combination. Variants force a compile step. The compile step forces deploy round-trips. Deploy round-trips kill the REPL shape.

The architectural choice at the very bottom — pick `wasm32-wasi` because it's "purer" and runs anywhere — propagated all the way up to the product shape and made the project unfit for the workload that actually matters now.

### 3. Static linking is a tarpit for "catch up to Pyodide"

Pyodide ships roughly 280 packages with a paid team behind it. PyMode shipped 5 C-extension variants and ~40 pure-Python packages. Each new C extension takes a recipe, often weeks of cross-compile work. scipy needs Fortran. lxml needs libxml2. cryptography needs OpenSSL or a Rust runtime. orjson is Rust. Recipes are the right shape for *someone with one C extension that isn't in Pyodide and is willing to maintain it themselves*. They are the wrong shape for closing a 275-package gap.

### 4. Cloudflare compiled Pyodide into workerd, which is a moat a third party can't cross

CF Python Workers don't pay the 10 MiB worker bundle cap for the interpreter because Pyodide lives inside workerd. They get memory snapshots that drop pandas cold start to ~1 s. A third party (me, PyMode) compiling CPython into the user's bundle pays both the 8 MB gz interpreter cost *and* the 25 s `import pandas` cost on cold isolates. PythonDO with a 30 s alarm keeps active regions warm, but a new isolate in a new region still pays the cost.

This is structural. No amount of build-system cleverness in user space closes the gap with a runtime that lives in workerd.

### 5. The fan-out replay cache is real engineering but it's not what people mean by "pipeline cache"

`worker/src/fanout.ts:1-17` implements a within-request replay loop: WASM runs synchronously, async host imports record sentinels, the JS layer resolves them in parallel via `Promise.all`, a new WASM instance replays with cached results. This avoids Asyncify's 30% size overhead.

It works. It's clever. But the cache lifetime is one request. It is *not* a cross-run provenance/Merkle cache like Modal or what Cloudflow's writeup describes. When other systems say "cache" they usually mean the latter. Worth being precise about which one you're talking about.

### 6. The piece that survives the lesson is the sandbox shape, not the wasm shape

`worker/src/sandbox-do.ts:51-98` — SandboxDO with R2-backed filesystem, per-session SQLite state, an `/exec` HTTP API — is architecturally independent of the wasm-Python choice. It would work identically with Pyodide-Workers underneath. That is the sub-architecture that should be salvaged for any future "Python session for AI" product. The wasm compile pipeline below it is the part to drop.

### 7. The Workflows/parallel APIs (`pymode.workflows`, `pymode.parallel`) are not the differentiator

Sequential durable steps and ThreadDO-based fan-out exist (`lib/pymode/workflows.py`, `lib/pymode/parallel.py`). They work. They are also exactly the surface that pipeline frameworks (Modal, Prefect, Dagster) provide with bigger package catalogs and no Cloudflare lock-in. PyMode's value at this layer is "fine, but why would I pick this over Modal." That's not a winning answer for a personal project competing with funded incumbents.

## What I would tell the next person

- If you want Python on Cloudflare in production: use CF Python Workers. They won. The 2026 version handles the cases PyMode was built for, better than PyMode does.
- If you want Python that AI can use ad-hoc: build a stateful REPL over MCP. Use Cloudflare Sandbox containers (or Pyodide Workers for the fast path). Do **not** ship your own CPython wasm and a recipe system.
- If you want a parallel Python pipeline framework: pick Modal, Prefect, Dagster, or Ray. Their catalogs are bigger and they're not locked to one cloud.
- If you have one C extension that genuinely isn't in Pyodide and you control the source: PyMode's recipe system still does the job. That is the narrow case where this code earns its keep.

## What's still useful in this repo

- The recipe system itself (`recipes/`, `scripts/build-recipe.ts`) for the one-off C-extension case.
- `worker/src/fanout.ts` as a worked example of replay-based async without Asyncify overhead.
- `worker/src/sandbox-do.ts` as a starting point for a stateful Python session DO, *if* paired with a different Python runtime.
- The polyfills (`lib/polyfills/`) as evidence of which stdlib modules actually need work to run under WASI.

## What I'd remove if I were starting over

- The wasm32-wasi commitment at the bottom of the stack. It's intellectually clean and product-hostile.
- The static-link variant model. Lazy-load via `dlopen` was the right call, even if it means Emscripten.
- The `on_fetch(request, env)` framing as the primary entry. REPL `exec` is the primary entry; request handling is a special case.
- The ambition to match Pyodide's catalog. That was never going to work at this scale.

## Status

The runtime works for what's documented. No active development. PRs welcome for recipe additions if you have a C extension that fits the model. Don't expect quick replies.
