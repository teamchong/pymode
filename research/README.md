# Python Library Compatibility Research

Analysis of popular Python libraries on Cloudflare Workers via pymode.

## Summary

| Library | Status | Why |
|---------|--------|-----|
| [langchain-core](./langchain/README.md) | **Works** | Pure Python LLM orchestration, ~30MB |
| [langgraph](./langgraph/README.md) | **Works** | Graph-based agent workflows, state machines |
| [pydantic](./pydantic.md) | **Works** | Compiled pydantic_core.wasm, validation/serialization |
| [fastapi](./fastapi.md) | **Works** | ASGI framework, great with pydantic for typed APIs |
| [numpy](./numpy.md) | **Works** | Compiled _multiarray_umath.wasm, numeric computing |
| [pandas](./pandas.md) | **Won't work** | ~100MB memory, exceeds Worker/DO limits |
| [scikit-learn](./scikit-learn.md) | **Won't work** | ~200MB+ memory, heavy C extensions |
| [tensorflow](./tensorflow.md) | **Won't work** | ~500MB+, GPU-dependent, not viable for WASM |
| [crewai](./crewai.md) | **Maybe** | Multi-agent framework, heavy dependency tree |

## Cloudflare Workers Constraints

| Resource | Worker | Durable Object |
|----------|--------|----------------|
| Memory | 128MB | 256MB |
| CPU per request | 10-50ms | 30s |
| Package size | 10MB compressed | 10MB compressed |
| Wall clock | ~30s | 60min (WebSocket/alarms) |

## What Makes Sense on Workers

**Good fit:** HTTP orchestration, API glue, data validation, LLM agent logic
- The worker calls external APIs (LLM providers, databases) — most time is I/O wait, not CPU
- Durable Objects provide state, hibernation, alarms for long-running agents

**Bad fit:** Heavy computation, large datasets, ML training/inference
- Use Workers AI for model inference instead
- Use external services (BigQuery, Snowflake) for data processing
