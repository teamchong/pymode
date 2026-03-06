# PyMode: Package Manager & Auto-Continuation Research

## Date: 2026-03-06

---

## 1. Threading → Real Child DO Parallelism

### Current State
The `threading.py` polyfill provides no-op locks and raises on `Thread.start()`. This unblocks imports but doesn't provide real parallelism.

### Target State
`Thread.start()` should spawn a real child DO via `pymode.parallel.spawn()`:

```python
import threading

def worker(data):
    return process(data)

# This should actually run in a child DO
t = threading.Thread(target=worker, args=(data,))
t.start()     # → _pymode.thread_spawn()
result = t.join()  # → _pymode.thread_join()
```

### Architecture
```
Thread.start() → pickle(target, args, kwargs)
  → _pymode.thread_spawn(code, pickled_input)
    → JS: ThreadDO.run(code, input)
      → child DO: python.wasm unpickle → call target → pickle result
  → _pymode.thread_join(thread_id)
    → JS: await ThreadDO result
      → unpickle → return to Python
```

### Limitations
- Each child DO gets its own 30s CPU, 128MB memory
- Arguments and results must be picklable (no lambdas/closures)
- Max 32 concurrent child DOs per request chain (CF limit)
- ~5ms overhead per spawn (DO instantiation + WASM cold start)

---

## 2. Auto-Continuation via CF Workflows

### Why NOT WASM Snapshots
CF's WASM snapshot tech (Wizer) is **deploy-time only**:
- Runs init code once at deploy → captures linear memory
- Every cold start restores from same snapshot
- Cannot snapshot arbitrary runtime state between requests

### CF Workflows (GA April 2025)
CF Workflows provides exactly what we need:

| Feature | Details |
|---------|---------|
| Step memoization | Each step's return value auto-persisted to SQLite |
| Max steps | 25,000 per workflow instance |
| Sleep | Up to 30 days between steps (no compute charges) |
| Wait for event | `step.waitForEvent()` for external signals |
| Retry | Configurable per-step: limit, delay, backoff |
| Python support | Beta — uses same WASM snapshot for cold starts |
| Pricing | Pay only for active CPU time |

### Integration Plan
Instead of building our own continuation system, PyMode should wrap CF Workflows:

```python
from pymode.workflows import Workflow

app = Workflow("data-pipeline")

@app.step(retries=3)
def extract(ctx):
    raw = ctx.env.SOURCE_KV.get("dataset")
    return {"rows": parse_csv(raw)}

@app.step
def transform(ctx):
    rows = ctx.results["extract"]["rows"]
    return {"cleaned": [clean(r) for r in rows]}

@app.step
def load(ctx):
    data = ctx.results["transform"]["cleaned"]
    ctx.env.DEST_KV.put("output", json.dumps(data))
    return {"count": len(data)}
```

Under the hood, each `@app.step` maps to a CF Workflow `step.do()`:
- Step return values automatically persisted
- On failure/timeout: CF retries from last completed step
- On 30s CPU limit: CF Workflows handles the continuation

### What We Build
1. Python `Workflow` class → generates JS Workflow class at deploy time
2. Each `@step` → a separate python.wasm invocation with pickled state
3. `step.sleep()` and `step.waitForEvent()` exposed as Python methods

---

## 3. Package Manager: Reuse metal0/packages/pkg

### What metal0 Already Has
A complete PubGrub-based package resolver in pure Zig:

| Component | Location | Status |
|-----------|----------|--------|
| PEP 440 version parser | `packages/pkg/src/parse/pep440.zig` | Complete |
| PEP 508 dependency parser | `packages/pkg/src/parse/pep508.zig` | Complete |
| requirements.txt parser | `packages/pkg/src/parse/requirements.zig` | Complete |
| PyPI HTTP/2 client | `packages/pkg/src/fetch/pypi.zig` | Complete |
| Wheel platform selector | `packages/pkg/src/fetch/wheel.zig` | Complete |
| PubGrub dependency solver | `packages/pkg/src/pubgrub/solver.zig` | Complete |
| Wheel installer | `packages/pkg/src/install/installer.zig` | Complete |
| RECORD parser (C ext detection) | `packages/pkg/src/parse/record.zig` | Complete |

### `pymode install` Pipeline

```
pymode install numpy jinja2 pyyaml
  │
  ├─ 1. Resolve dependencies (PubGrub solver)
  │     └─ PyPI HTTP/2 + SIMD JSON for metadata
  │
  ├─ 2. Download wheels
  │     └─ Prefer py3-none-any (pure Python)
  │     └─ For C extensions: download cp313-cp313-wasm32 or sdist
  │
  ├─ 3. Classify each package
  │     ├─ Pure Python → extract .py files → site-packages.zip
  │     ├─ Small C ext → zig cc → .wasm side module (dl_open)
  │     └─ Large C ext (numpy) → separate Pyodide worker
  │
  ├─ 4. Bundle
  │     ├─ site-packages.zip → worker/src/ (pure Python)
  │     ├─ .wasm side modules → worker/src/extensions/
  │     └─ service-bindings.toml → for large packages
  │
  └─ 5. Generate wrangler.toml additions
        ├─ [wasm_modules] for side modules
        └─ [[services]] for heavy-package workers
```

### Wheel Platform Tags for WASM
We need a new platform tag: `wasm32-wasi` or `wasm32-pymode`.

For pure Python wheels (`py3-none-any`): work as-is.
For C extension wheels: need to be compiled from sdist using `zig cc -target wasm32-wasi`.

### Size Budget
| Component | Compressed Size |
|-----------|----------------|
| python.wasm | ~1.8MB gz |
| stdlib-fs.ts | ~600KB gz |
| PyMode runtime | ~50KB gz |
| Available for packages | ~7.5MB gz |
| Pure Python packages fit | ~50-100 packages |
| With Service Bindings | Unlimited (10MB per worker) |

### What We Need to Build
1. **Zig CLI tool** (`pymode` binary) that calls into `packages/pkg/` for resolution
2. **WASM wheel compiler** — extends `build-extension.sh` to handle arbitrary C extensions
3. **Auto-split logic** — when total size exceeds 10MB, auto-create Service Binding workers
4. **wasm32-wasi platform tag** — teach wheel selector to handle WASM target

### Reuse Strategy
- Fork `packages/pkg/` or import as Zig module
- Add `wasm32-wasi` to `fetch/wheel.zig` platform tags
- Add `pymode` output format to `install/installer.zig`
- The resolver, fetcher, and parser are 100% reusable as-is

---

## 4. Implementation Priority

| Priority | Task | Impact |
|----------|------|--------|
| 1 | Threading shim → real DO spawn | Unblocks packages using Thread for background work |
| 2 | CF Workflows integration | Enables long-running tasks (>30s) |
| 3 | `pymode install` CLI | Makes package management automatic |
| 4 | WASM wheel compiler | Enables C extensions without manual build |
| 5 | Auto-split for large packages | Seamless multi-worker deployment |

---

## Sources
- [CF Durable Objects Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [CF Workflows GA](https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/)
- [CF Workflows Docs](https://developers.cloudflare.com/workflows/)
- [CF Python Workers Snapshots](https://blog.cloudflare.com/python-workers-advancements/)
- [CF Workflows Step Limit 25K](https://community.cloudflare.com/t/workflows-workers-workflows-step-limit-increased-to-25-000-steps-per-instance/900629)
- [Wizer Pre-Initializer](https://github.com/bytecodealliance/wizer)
- metal0 `packages/pkg/` — full PubGrub package manager in Zig
