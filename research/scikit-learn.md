# scikit-learn

**Status: Won't Work**

## What It Is

Machine learning library. Classification, regression, clustering, dimensionality
reduction, model selection, preprocessing.

## Why It Won't Work on Workers

| Constraint | scikit-learn Needs | Worker Limit |
|------------|-------------------|--------------|
| Memory | ~200MB+ | 128MB / 256MB DO |
| Package size | ~50MB compressed | 10MB budget |
| C extensions | Cython + BLAS + LAPACK | Complex WASM compilation |
| Dependencies | numpy + scipy + joblib | scipy alone is ~100MB |

## The Core Problem

scikit-learn depends on scipy, which depends on BLAS/LAPACK (Fortran linear algebra
libraries). Compiling this entire stack to WASM is theoretically possible but would
produce a binary far exceeding Workers' limits.

## Alternatives for Workers

| Need | Use Instead |
|------|-------------|
| Model inference | **Workers AI** — run Llama, Mistral, etc. on CF GPUs |
| Classification/regression | Pre-trained model as ONNX, run via Workers AI |
| Feature engineering | numpy (works on pymode) |
| ML pipeline orchestration | LangChain (works on pymode) to call external ML APIs |

## The Right Architecture

```
Training: Done offline (your laptop, cloud GPU, etc.)
  → Export model as ONNX / API endpoint

Inference on Workers:
  User Request → Worker
    → Workers AI (run ONNX model)
    → or External ML API (SageMaker, Vertex AI)
    → Response
```

Don't train or run sklearn on Workers. Use Workers to orchestrate ML inference
via external services.
