# API Worker

Multi-file PyMode example with CORS middleware and KV-backed CRUD API.

## Run locally

```bash
cd examples/api-worker
pymode dev
# → http://localhost:8787
```

Note: KV operations require the production WASM runtime. In dev mode,
`env.MY_KV.get()` will raise an error unless you mock the data.

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/items` | List all items |
| POST | `/api/items` | Create an item (JSON body) |
| GET | `/api/items/:id` | Get item by ID |

## Project structure

```
src/
  entry.py        Main handler — CORS preflight + routing
  routes.py       API route handlers (list, create, get)
  middleware.py   CORS header helper
```
