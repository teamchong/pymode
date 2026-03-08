# numpy

**Status: Works**

## What It Is

Fundamental package for numerical computing in Python. Array operations,
linear algebra, FFT, random number generation.

## Why It Works on Workers

- Core C extension (_multiarray_umath) compiled to WASM as a built-in module
- Requires `python-numpy.wasm` variant (~8MB)
- ~50MB memory footprint (fits in 128MB Worker)
- No BLAS/LAPACK (no scipy-level linear algebra)

## What Works

- Array creation and manipulation
- Basic math (mean, std, sum, etc.)
- Matrix operations (dot, matmul)
- FFT (`np.fft`)
- Random number generation (`np.random.default_rng`)
- Sorting, percentile, statistical functions

## What Doesn't Work

- `np.linalg.eig`, `np.linalg.svd` — need LAPACK
- scipy — too large, needs Fortran extensions
- GPU operations — no CUDA in WASM

## Cold Start

- ~1-2s for numpy import

## Test Command

```bash
npx vitest run test/numpy.test.ts
```

## Use Case on Workers

```python
import numpy as np

def on_fetch(request, env):
    data = np.array(request.json()["values"])
    return {
        "mean": float(np.mean(data)),
        "std": float(np.std(data)),
        "percentile_95": float(np.percentile(data, 95)),
    }
```
