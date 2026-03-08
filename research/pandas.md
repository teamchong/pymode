# pandas

**Status: Won't Work**

## What It Is

Data analysis library. DataFrames, CSV/Excel reading, groupby, merge, pivot tables.

## Why It Won't Work on Workers

| Constraint | pandas Needs | Worker Limit |
|------------|-------------|--------------|
| Memory | ~100MB just to import | 128MB (Worker) / 256MB (DO) |
| Package size | ~30MB compressed | 10MB total budget |
| C extensions | numpy + own C code | Need WASM compilation |

Even if you could compile it, importing pandas leaves almost no memory for actual data.

## What About Just numpy?

numpy works (see [numpy.md](./numpy.md)) and gives you arrays, math, and statistics.
For simple tabular operations, you can use:

- `csv` module (stdlib) — parsing
- `json` module (stdlib) — data interchange
- numpy arrays — numeric operations
- List comprehensions — filtering, mapping

## Alternatives for Workers

| Need | Use Instead |
|------|-------------|
| CSV parsing | `csv` module (stdlib) |
| Data validation | pydantic models |
| Numeric computation | numpy |
| Large dataset processing | Call external service (BigQuery, Snowflake, D1) |
| Data transformation | Python list/dict operations |

## The Right Architecture

```
User Request → Worker (light processing, validation)
  → D1/KV (structured queries)
  → External API (BigQuery, Snowflake for heavy analytics)
  → Response
```

Workers should orchestrate, not compute. pandas is a compute-heavy library
designed for local data analysis, not edge HTTP handlers.
