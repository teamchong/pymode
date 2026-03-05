# Hello Worker

Minimal PyMode example — a single handler with GET routes.

## Run locally

```bash
cd examples/hello-worker
pymode dev
# → http://localhost:8787
```

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Returns "Hello from PyMode!" |
| GET | `/json` | Returns JSON with method, URL |
| POST | `/echo` | Echoes request body and headers |
| GET | `/greet?name=X` | Returns "Hello, X!" |
