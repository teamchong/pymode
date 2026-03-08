# TS → Python Service Binding Example

Package any Python library as a typed, importable service for TypeScript workers.

## Architecture

```
┌─────────────────────┐    DO RPC     ┌────────────────────────┐
│  ts-worker           │─────────────▶│  python-service         │
│  (TypeScript)        │              │  (PyMode)               │
│                      │              │                         │
│  /stats    ──▶ callFunction("src.analytics", "summarize")    │
│  /tokenize ──▶ callFunction("src.analytics", "tokenize")     │
│  /render   ──▶ callFunction("src.analytics", "render_template")│
└─────────────────────┘              └────────────────────────┘
```

## How It Works

1. **Python service** (`python-service/`) — standard PyMode worker with Python functions
2. **TS worker** (`ts-worker/`) — calls Python via `PythonDO.callFunction()`
3. Communication uses Durable Object RPC — no HTTP serialization, sub-ms latency

## Usage

```typescript
// Get a reference to the Python DO
const doId = env.PYTHON_DO.idFromName("default");
const pythonDO = env.PYTHON_DO.get(doId) as unknown as PythonDORpc;

// Call any Python function with typed args
const result = await pythonDO.callFunction(
  "src.analytics",    // Python module path
  "summarize",        // Function name
  { values: [1, 2, 3] }  // Keyword arguments (JSON-serializable)
);

console.log(result.returnValue);
// { count: 3, mean: 2.0, median: 2.0, std: 0.8165, min: 1, max: 3, sum: 6 }
```

## Deploy

```bash
# 1. Deploy the Python service
cd python-service
pymode deploy

# 2. Deploy the TS worker
cd ../ts-worker
npx wrangler deploy
```
