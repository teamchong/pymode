// CF Bindings Tests — KV, R2, D1, Environment Variables
//
// These test the REAL production path through PythonDO host imports:
//   Python calls env.MY_KV.put() → _pymode.kv_put() → WASM import → Asyncify suspend
//   → PythonDO JS: self.env["MY_KV"].put() → miniflare KV → Asyncify resume
//
// Requires: wrangler dev running with KV/R2/D1 bindings (test/wrangler.toml)

import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

// --- KV Bindings ---

describe("KV bindings", () => {
  it("basic _pymode import works", async () => {
    const { text, status } = await runPython(`
import _pymode
print(f"has_kv_get={hasattr(_pymode, 'kv_get')}")
print(f"has_kv_put={hasattr(_pymode, 'kv_put')}")
`);
    if (status !== 200) console.log("_pymode import error:", text);
    expect(status).toBe(200);
    expect(text).toContain("has_kv_get=True");
  });

  it("writes and reads back values", async () => {
    const { text, status } = await runPython(`
import _pymode
try:
    _pymode.kv_put("MY_KV\\x00test-key", b"test-value-123")
    result = _pymode.kv_get("MY_KV\\x00test-key")
    if result is None:
        print("result=None")
    else:
        print(f"result={result.decode()}")
except Exception as e:
    print(f"error={type(e).__name__}: {e}")
`);
    if (status !== 200) console.log("KV write/read error:", text);
    expect(status).toBe(200);
    expect(text).toContain("result=test-value-123");
  });

  it("returns None for missing keys", async () => {
    const { text, status } = await runPython(`
from pymode.workers import Env
env = Env()
value = env.MY_KV.get("nonexistent-key-12345")
print(f"result={value}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=None");
  });

  it("deletes keys", async () => {
    const { text, status } = await runPython(`
from pymode.workers import Env
env = Env()
env.MY_KV.put("temp-key", "temporary")
before = env.MY_KV.get("temp-key")
print(f"before={before}")
env.MY_KV.delete("temp-key")
after = env.MY_KV.get("temp-key")
print(f"after={after}")
`);
    expect(status).toBe(200);
    expect(text).toContain("before=temporary");
    expect(text).toContain("after=None");
  });

  it("handles JSON data round-trip", async () => {
    const { text, status } = await runPython(`
import json
from pymode.workers import Env
env = Env()
data = {"users": ["alice", "bob"], "count": 2}
env.MY_KV.put("json-data", json.dumps(data))
result = json.loads(env.MY_KV.get("json-data"))
print(f"users={result['users']}")
print(f"count={result['count']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("users=['alice', 'bob']");
    expect(text).toContain("count=2");
  });
});

// --- R2 Bindings ---

describe("R2 bindings", () => {
  it("writes and reads back objects", async () => {
    const { text, status } = await runPython(`
from pymode.workers import Env
env = Env()
env.MY_R2.put("test-file.txt", b"hello from R2")
data = env.MY_R2.get("test-file.txt")
print(f"content={data.decode('utf-8')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("content=hello from R2");
  });

  it("returns None for missing objects", async () => {
    const { text, status } = await runPython(`
from pymode.workers import Env
env = Env()
data = env.MY_R2.get("does-not-exist.txt")
print(f"result={data}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=None");
  });
});

// --- D1 Bindings ---

describe("D1 bindings", () => {
  it("creates table and queries", async () => {
    const { text, status } = await runPython(`
from pymode.workers import Env
env = Env()
env.MY_DB.prepare("CREATE TABLE IF NOT EXISTS test_users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER)").run()
env.MY_DB.prepare("INSERT INTO test_users (name, age) VALUES (?, ?)").bind("Alice", 30).run()
env.MY_DB.prepare("INSERT INTO test_users (name, age) VALUES (?, ?)").bind("Bob", 25).run()
result = env.MY_DB.prepare("SELECT * FROM test_users ORDER BY name").all()
rows = result["results"]
print(f"count={len(rows)}")
print(f"first={rows[0]['name']}")
print(f"second={rows[1]['name']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("count=2");
    expect(text).toContain("first=Alice");
    expect(text).toContain("second=Bob");
  });

  it("uses prepare().first()", async () => {
    const { text, status } = await runPython(`
from pymode.workers import Env
env = Env()
env.MY_DB.prepare("CREATE TABLE IF NOT EXISTS test_items (id INTEGER PRIMARY KEY, name TEXT)").run()
env.MY_DB.prepare("INSERT OR IGNORE INTO test_items (id, name) VALUES (1, 'Widget')").run()
row = env.MY_DB.prepare("SELECT * FROM test_items WHERE id = ?").bind(1).first()
print(f"name={row['name']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=Widget");
  });
});

// --- Environment Variables ---

describe("Environment variables", () => {
  it("reads env vars via Env class", async () => {
    const { text, status } = await runPython(`
from pymode.env import get_env
val = get_env("NODE_ENV")
print(f"node_env={val}")
`);
    expect(status).toBe(200);
    expect(text).toContain("node_env=test");
  });
});

// --- Workers API ---

describe("Workers API", () => {
  it("Request parses URL and headers", async () => {
    const { text, status } = await runPython(`
from pymode.workers import Request
req = Request(method="GET", url="https://example.com/api/users?page=2")
print(f"path={req.path}")
print(f"method={req.method}")
`);
    expect(status).toBe(200);
    expect(text).toContain("path=/api/users");
    expect(text).toContain("method=GET");
  });

  it("Response auto-detects content type", async () => {
    const { text, status } = await runPython(`
from pymode.workers import Response
r1 = Response({"key": "value"})
print(f"dict_ct={r1.headers.get('Content-Type')}")
r2 = Response("hello")
print(f"str_ct={r2.headers.get('Content-Type')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("dict_ct=application/json");
    expect(text).toContain("str_ct=text/plain");
  });

  it("Response.json() class method", async () => {
    const { text, status } = await runPython(`
from pymode.workers import Response
r = Response.json({"users": [1, 2, 3]}, status=201)
print(f"status={r.status}")
print(f"ct={r.headers.get('Content-Type')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("status=201");
    expect(text).toContain("ct=application/json");
  });
});
