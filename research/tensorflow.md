# TensorFlow

**Status: Won't Work**

## What It Is

Deep learning framework. Neural networks, model training, inference.

## Why It Won't Work on Workers

| Constraint | TensorFlow Needs | Worker Limit |
|------------|-----------------|--------------|
| Memory | ~500MB+ | 128MB / 256MB DO |
| Package size | ~200MB compressed | 10MB budget |
| Runtime | C++/CUDA/Metal | WASM only |
| GPU | Required for practical use | Not available |

TensorFlow is fundamentally incompatible with Workers. It's designed for GPU-accelerated
training and inference on dedicated hardware.

## Not Even TensorFlow Lite?

TFLite is smaller (~5MB) but still needs:
- Native C++ runtime compiled to WASM
- Model files (MBs to GBs)
- More memory than Workers allows for most models

## Alternatives for Workers

| Need | Use Instead |
|------|-------------|
| LLM inference | **Workers AI** — Llama, Mistral on CF edge GPUs |
| Image classification | Workers AI with vision models |
| Custom model inference | ONNX Runtime via Workers AI |
| Model orchestration | LangChain on pymode → call external APIs |

## The Right Architecture

```
Model Training: Done offline (cloud GPU)
  → Export to Workers AI compatible format

Edge Inference:
  User Request → Worker
    → env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages })
    → Response (runs on CF's edge GPUs, not in your Worker)
```

Workers AI is Cloudflare's answer to "I want ML at the edge."
It runs on dedicated GPU hardware, not in your Worker's WASM sandbox.
