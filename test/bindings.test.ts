// CF Bindings Tests — KV, R2, D1, HTTP, Environment Variables
//
// These test the REAL host import protocol: Python calls _pymode.kv_get()
// which writes into WASM linear memory, JS reads the pointer, looks up the
// in-memory store, and writes the result back into WASM memory.
//
// Every binding actually reads and writes through WASM memory pointers,
// the same protocol as the production PythonDO.

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function run(code: string): Promise<{ text: string; status: number }> {
  const response = await SELF.fetch("http://localhost", {
    method: "POST",
    body: code,
  });
  const text = await response.text();
  return { text: text.trim(), status: response.status };
}

// --- KV Bindings ---

describe("KV bindings", () => {
  it("reads pre-seeded values", async () => {
    const { text, status } = await run(`
from pymode.env import KV
data = KV.get("greeting")
print(f"type={type(data).__name__}")
print(f"value={data.decode('utf-8')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("type=bytes");
    expect(text).toContain("value=Hello from KV!");
  });

  it("returns None for missing keys", async () => {
    const { text, status } = await run(`
from pymode.env import KV
data = KV.get("nonexistent-key")
print(f"result={data}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=None");
  });

  it("writes and reads back values", async () => {
    const { text, status } = await run(`
from pymode.env import KV
KV.put("test-key", b"test-value-123")
data = KV.get("test-key")
print(f"value={data.decode('utf-8')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("value=test-value-123");
  });

  it("deletes keys", async () => {
    const { text, status } = await run(`
from pymode.env import KV
KV.put("temp-key", b"temporary")
before = KV.get("temp-key")
print(f"before={before.decode('utf-8')}")
KV.delete("temp-key")
after = KV.get("temp-key")
print(f"after={after}")
`);
    expect(status).toBe(200);
    expect(text).toContain("before=temporary");
    expect(text).toContain("after=None");
  });

  it("handles JSON data round-trip", async () => {
    const { text, status } = await run(`
import json
from pymode.env import KV
data = json.loads(KV.get("json-data").decode("utf-8"))
print(f"users={data['users']}")
print(f"count={data['count']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("users=['alice', 'bob']");
    expect(text).toContain("count=2");
  });

  it("handles binary data", async () => {
    const { text, status } = await run(`
from pymode.env import KV
binary = bytes(range(256))
KV.put("binary-key", binary)
result = KV.get("binary-key")
print(f"len={len(result)}")
print(f"first_10={list(result[:10])}")
print(f"last_5={list(result[-5:])}")
print(f"match={result == binary}")
`);
    expect(status).toBe(200);
    expect(text).toContain("len=256");
    expect(text).toContain("first_10=[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]");
    expect(text).toContain("last_5=[251, 252, 253, 254, 255]");
    expect(text).toContain("match=True");
  });
});

// --- KV via workers.py Binding ---

describe("KV via workers.py", () => {
  it("uses KVBinding.get with type=text", async () => {
    const { text, status } = await run(`
from pymode.workers import Env
env = Env()
value = env.MY_KV.get("greeting", type="text")
print(f"value={value}")
print(f"type={type(value).__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("value=Hello from KV!");
    expect(text).toContain("type=str");
  });

  it("uses KVBinding.get with type=json", async () => {
    const { text, status } = await run(`
from pymode.workers import Env
env = Env()
data = env.MY_KV.get("json-data", type="json")
print(f"users={data['users']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("users=['alice', 'bob']");
  });

  it("uses KVBinding.put and delete", async () => {
    const { text, status } = await run(`
from pymode.workers import Env
env = Env()
env.MY_KV.put("wk-key", "worker-value")
val = env.MY_KV.get("wk-key")
print(f"put_get={val}")
env.MY_KV.delete("wk-key")
gone = env.MY_KV.get("wk-key")
print(f"deleted={gone}")
`);
    expect(status).toBe(200);
    expect(text).toContain("put_get=worker-value");
    expect(text).toContain("deleted=None");
  });
});

// --- R2 Bindings ---

describe("R2 bindings", () => {
  it("reads pre-seeded objects", async () => {
    const { text, status } = await run(`
from pymode.env import R2
data = R2.get("readme.txt")
print(f"content={data.decode('utf-8')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("content=PyMode R2 test file contents");
  });

  it("returns None for missing objects", async () => {
    const { text, status } = await run(`
from pymode.env import R2
data = R2.get("does-not-exist.txt")
print(f"result={data}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=None");
  });

  it("writes and reads back objects", async () => {
    const { text, status } = await run(`
from pymode.env import R2
R2.put("upload.txt", b"uploaded content here")
data = R2.get("upload.txt")
print(f"content={data.decode('utf-8')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("content=uploaded content here");
  });

  it("handles binary objects (PNG header)", async () => {
    const { text, status } = await run(`
from pymode.env import R2
data = R2.get("image.bin")
print(f"len={len(data)}")
print(f"png_magic={data[:4] == bytes([0x89, 0x50, 0x4E, 0x47])}")
`);
    expect(status).toBe(200);
    expect(text).toContain("len=8");
    expect(text).toContain("png_magic=True");
  });

  it("reads JSON from R2 and parses it", async () => {
    const { text, status } = await run(`
import json
from pymode.env import R2
raw = R2.get("data.json")
data = json.loads(raw.decode("utf-8"))
print(f"version={data['version']}")
print(f"items={data['items']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("version=1");
    expect(text).toContain("items=[1, 2, 3]");
  });
});

// --- D1 Bindings ---

describe("D1 bindings", () => {
  it("SELECT * from pre-seeded table", async () => {
    const { text, status } = await run(`
from pymode.env import D1
rows = D1.execute("SELECT * FROM users", [])
print(f"count={len(rows)}")
for r in rows:
    print(f"user={r['name']},email={r['email']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("count=3");
    expect(text).toContain("user=Alice,email=alice@example.com");
    expect(text).toContain("user=Bob,email=bob@example.com");
    expect(text).toContain("user=Charlie,email=charlie@example.com");
  });

  it("SELECT with WHERE clause", async () => {
    const { text, status } = await run(`
from pymode.env import D1
rows = D1.execute("SELECT * FROM users WHERE id = ?", [2])
print(f"count={len(rows)}")
print(f"name={rows[0]['name']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("count=1");
    expect(text).toContain("name=Bob");
  });

  it("SELECT with ORDER BY and LIMIT", async () => {
    const { text, status } = await run(`
from pymode.env import D1
rows = D1.execute("SELECT * FROM users ORDER BY age DESC LIMIT 2", [])
print(f"count={len(rows)}")
print(f"first={rows[0]['name']}")
print(f"second={rows[1]['name']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("count=2");
    expect(text).toContain("first=Charlie");
    expect(text).toContain("second=Alice");
  });

  it("INSERT adds rows", async () => {
    const { text, status } = await run(`
from pymode.env import D1
D1.execute("INSERT INTO users (name, email, age) VALUES (?, ?, ?)", ["Diana", "diana@example.com", 28])
rows = D1.execute("SELECT * FROM users WHERE name = ?", ["Diana"])
print(f"found={len(rows)}")
print(f"email={rows[0]['email']}")
print(f"age={rows[0]['age']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("found=1");
    expect(text).toContain("email=diana@example.com");
    expect(text).toContain("age=28");
  });

  it("UPDATE modifies rows", async () => {
    const { text, status } = await run(`
from pymode.env import D1
D1.execute("UPDATE products SET price = ? WHERE id = ?", [19.99, 1])
rows = D1.execute("SELECT * FROM products WHERE id = ?", [1])
print(f"name={rows[0]['name']}")
print(f"price={rows[0]['price']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=Widget");
    expect(text).toContain("price=19.99");
  });

  it("DELETE removes rows", async () => {
    const { text, status } = await run(`
from pymode.env import D1
before = D1.execute("SELECT * FROM products", [])
print(f"before={len(before)}")
D1.execute("DELETE FROM products WHERE id = ?", [2])
after = D1.execute("SELECT * FROM products", [])
print(f"after={len(after)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("before=2");
    expect(text).toContain("after=1");
  });
});

// --- D1 via workers.py Binding ---

describe("D1 via workers.py", () => {
  it("uses D1Binding.prepare().bind().all()", async () => {
    const { text, status } = await run(`
from pymode.workers import Env
env = Env()
result = env.MY_DB.prepare("SELECT * FROM users WHERE age = ?").bind(30).all()
rows = result["results"]
print(f"count={len(rows)}")
print(f"name={rows[0]['name']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("count=1");
    expect(text).toContain("name=Alice");
  });

  it("uses D1Binding.prepare().first()", async () => {
    const { text, status } = await run(`
from pymode.workers import Env
env = Env()
row = env.MY_DB.prepare("SELECT * FROM users WHERE id = ?").bind(1).first()
print(f"name={row['name']}")
email = env.MY_DB.prepare("SELECT * FROM users WHERE id = ?").bind(2).first("email")
print(f"email={email}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=Alice");
    expect(text).toContain("email=bob@example.com");
  });
});

// --- HTTP Bindings ---

describe("HTTP bindings", () => {
  it("fetches a mock JSON endpoint", async () => {
    const { text, status } = await run(`
import json
from pymode.http import fetch
resp = fetch("mock://json")
print(f"status={resp.status}")
data = json.loads(resp.read().decode("utf-8"))
print(f"message={data['message']}")
print(f"method={data['method']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("status=200");
    expect(text).toContain("message=hello");
    expect(text).toContain("method=GET");
  });

  it("sends POST with body and echoes back", async () => {
    const { text, status } = await run(`
from pymode.http import fetch
resp = fetch("mock://echo", method="POST", body=b"hello world")
body = resp.read()
print(f"status={resp.status}")
print(f"body={body.decode('utf-8')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("status=200");
    expect(text).toContain("body=hello world");
  });

  it("sends custom headers", async () => {
    const { text, status } = await run(`
import json
from pymode.http import fetch
resp = fetch("mock://headers", headers={"X-Custom": "test-value", "Authorization": "Bearer token123"})
data = json.loads(resp.read().decode("utf-8"))
print(f"custom={data.get('X-Custom')}")
print(f"auth={data.get('Authorization')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("custom=test-value");
    expect(text).toContain("auth=Bearer token123");
  });

  it("handles 404 responses", async () => {
    const { text, status } = await run(`
from pymode.http import fetch
resp = fetch("mock://status/404")
print(f"status={resp.status}")
print(f"body={resp.read().decode('utf-8')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("status=404");
    expect(text).toContain("body=Not Found");
  });

  it("reads response headers", async () => {
    const { text, status } = await run(`
from pymode.http import fetch
resp = fetch("mock://json")
ct = resp.getheader("content-type")
print(f"content_type={ct}")
`);
    expect(status).toBe(200);
    expect(text).toContain("content_type=application/json");
  });

  it("uses get/post helpers", async () => {
    const { text, status } = await run(`
import json
from pymode.http import get, post
r1 = get("mock://json")
d1 = json.loads(r1.read().decode("utf-8"))
print(f"get_method={d1['method']}")
r2 = post("mock://echo", body=b"post-data")
print(f"post_body={r2.read().decode('utf-8')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("get_method=GET");
    expect(text).toContain("post_body=post-data");
  });
});

// --- Environment Variables ---

describe("Environment variables", () => {
  it("reads pre-set env vars", async () => {
    const { text, status } = await run(`
from pymode.env import get_env
secret = get_env("TEST_SECRET")
api_key = get_env("API_KEY")
print(f"secret={secret}")
print(f"api_key={api_key}")
`);
    expect(status).toBe(200);
    expect(text).toContain("secret=my-secret-value");
    expect(text).toContain("api_key=test-api-key-12345");
  });

  it("returns None for missing vars", async () => {
    const { text, status } = await run(`
from pymode.env import get_env
result = get_env("NONEXISTENT_VAR")
print(f"result={result}")
`);
    expect(status).toBe(200);
    expect(text).toContain("result=None");
  });

  it("accessible via Env class", async () => {
    const { text, status } = await run(`
from pymode.workers import Env
env = Env()
db_url = env.DATABASE_URL
print(f"db_url={db_url}")
`);
    expect(status).toBe(200);
    expect(text).toContain("db_url=postgres://localhost/testdb");
  });
});

// --- Console Log ---

describe("Console log", () => {
  it("logs messages via host import", async () => {
    const { text, status } = await run(`
from pymode.env import console_log
console_log("test message from python")
print("logged_ok=True")
`);
    expect(status).toBe(200);
    expect(text).toContain("logged_ok=True");
  });
});

// --- Integration: Full Request Handler ---

describe("integration: request handler pattern", () => {
  it("KV-backed API handler", async () => {
    const { text, status } = await run(`
import json
from pymode.workers import Response, Env
from pymode.env import KV

KV.put("config", json.dumps({"feature_flags": {"dark_mode": True, "beta": False}}).encode())
config = json.loads(KV.get("config").decode())
resp = Response.json({"flags": config["feature_flags"], "status": "ok"})
data = json.loads(resp.body)
print(f"dark_mode={data['flags']['dark_mode']}")
print(f"beta={data['flags']['beta']}")
print(f"status_code={resp.status}")
`);
    expect(status).toBe(200);
    expect(text).toContain("dark_mode=True");
    expect(text).toContain("beta=False");
    expect(text).toContain("status_code=200");
  });

  it("D1 query + R2 storage pipeline", async () => {
    const { text, status } = await run(`
import json
from pymode.env import D1, R2

users = D1.execute("SELECT name, email FROM users ORDER BY name ASC", [])

report = json.dumps({"generated": True, "user_count": len(users), "users": users})
R2.put("reports/users.json", report.encode())

stored = json.loads(R2.get("reports/users.json").decode())
print(f"user_count={stored['user_count']}")
print(f"first_user={stored['users'][0]['name']}")
print(f"generated={stored['generated']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("user_count=3");
    expect(text).toContain("first_user=Alice");
    expect(text).toContain("generated=True");
  });

  it("HTTP fetch + KV cache pattern", async () => {
    const { text, status } = await run(`
import json
from pymode.env import KV
from pymode.http import get

resp = get("mock://json")
data = resp.read()

KV.put("cache:api-response", data)

cached = json.loads(KV.get("cache:api-response").decode())
print(f"cached_message={cached['message']}")
print(f"cached_method={cached['method']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("cached_message=hello");
    expect(text).toContain("cached_method=GET");
  });

  it("environment-driven configuration", async () => {
    const { text, status } = await run(`
from pymode.env import get_env
from pymode.workers import Response

api_key = get_env("API_KEY")
db_url = get_env("DATABASE_URL")

config = {
    "has_api_key": api_key is not None,
    "api_key_prefix": api_key[:8] if api_key else None,
    "db_host": db_url.split("//")[1].split("/")[0] if db_url else None,
}

resp = Response.json(config)
import json
data = json.loads(resp.body)
print(f"has_api_key={data['has_api_key']}")
print(f"api_key_prefix={data['api_key_prefix']}")
print(f"db_host={data['db_host']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_api_key=True");
    expect(text).toContain("api_key_prefix=test-api");
    expect(text).toContain("db_host=localhost");
  });
});

// --- Workers API (Request/Response/Headers/Env) ---

describe("Workers API", () => {
  it("Request parses URL path and query", async () => {
    const { text, status } = await run(`
from pymode.workers import Request
req = Request(method="GET", url="https://example.com/api/users?page=2&sort=name")
print(f"path={req.path}")
print(f"query={req.query}")
print(f"method={req.method}")
`);
    expect(status).toBe(200);
    expect(text).toContain("path=/api/users");
    expect(text).toContain("page");
    expect(text).toContain("2");
    expect(text).toContain("method=GET");
  });

  it("Request body methods work", async () => {
    const { text, status } = await run(`
from pymode.workers import Request
import json

# String body
req = Request(body='{"key": "value"}')
print(f"text={req.text()}")
print(f"json={req.json()}")
print(f"bytes_type={type(req.bytes()).__name__}")

# Bytes body
req2 = Request(body=b'binary data')
print(f"text2={req2.text()}")
print(f"bytes2={req2.bytes()}")
`);
    expect(status).toBe(200);
    expect(text).toContain('text={"key": "value"}');
    expect(text).toContain("json={'key': 'value'}");
    expect(text).toContain("bytes_type=bytes");
    expect(text).toContain("text2=binary data");
  });

  it("Response auto-detects content type", async () => {
    const { text, status } = await run(`
from pymode.workers import Response
import json

# Dict body -> JSON
r1 = Response({"key": "value"})
print(f"dict_ct={r1.headers.get('Content-Type')}")
print(f"dict_body={r1.body}")

# String body -> text/plain
r2 = Response("hello")
print(f"str_ct={r2.headers.get('Content-Type')}")

# Bytes body -> octet-stream
r3 = Response(b"binary")
print(f"bytes_ct={r3.headers.get('Content-Type')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("dict_ct=application/json");
    expect(text).toContain("str_ct=text/plain");
    expect(text).toContain("bytes_ct=application/octet-stream");
  });

  it("Response.json() and Response.redirect() class methods", async () => {
    const { text, status } = await run(`
from pymode.workers import Response

r1 = Response.json({"users": [1, 2, 3]}, status=201)
print(f"json_status={r1.status}")
print(f"json_ct={r1.headers.get('Content-Type')}")

r2 = Response.redirect("https://example.com/new")
print(f"redirect_status={r2.status}")
print(f"redirect_location={r2.headers.get('Location')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("json_status=201");
    expect(text).toContain("json_ct=application/json");
    expect(text).toContain("redirect_status=302");
    expect(text).toContain("redirect_location=https://example.com/new");
  });

  it("Headers are case-insensitive", async () => {
    const { text, status } = await run(`
from pymode.workers import Headers

h = Headers({"Content-Type": "text/html", "X-Custom": "value"})
print(f"ct={h.get('content-type')}")
print(f"CT={h.get('CONTENT-TYPE')}")
print(f"custom={h.get('x-custom')}")
print(f"missing={h.get('x-missing', 'default')}")
print(f"contains={'content-type' in h}")
print(f"keys={sorted(h.keys())}")
`);
    expect(status).toBe(200);
    expect(text).toContain("ct=text/html");
    expect(text).toContain("CT=text/html");
    expect(text).toContain("custom=value");
    expect(text).toContain("missing=default");
    expect(text).toContain("contains=True");
  });

  it("Response._serialize() for WASM boundary", async () => {
    const { text, status } = await run(`
from pymode.workers import Response
import json

# String response
r1 = Response("hello", status=200, headers={"X-Test": "1"})
s1 = r1._serialize()
print(f"status={s1['status']}")
print(f"body={s1['body']}")
print(f"binary={s1['bodyIsBinary']}")

# Binary response
r2 = Response(b"\\x00\\x01\\x02")
s2 = r2._serialize()
print(f"bin_binary={s2['bodyIsBinary']}")
print(f"bin_body_type={type(s2['body']).__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("status=200");
    expect(text).toContain("body=hello");
    expect(text).toContain("binary=False");
    expect(text).toContain("bin_binary=True");
    expect(text).toContain("bin_body_type=str");
  });

  it("Env auto-detects binding types", async () => {
    const { text, status } = await run(`
from pymode.workers import Env, KVBinding, R2Binding, D1Binding

env = Env()
print(f"kv={type(env.MY_KV).__name__}")
print(f"r2={type(env.BUCKET_R2).__name__}")
print(f"d1={type(env.DB_D1).__name__}")
print(f"db={type(env.MY_DB).__name__}")
print(f"kv2={type(env.KV).__name__}")

# Missing binding raises AttributeError
try:
    env.NONEXISTENT
    print("no error")
except AttributeError as e:
    print(f"error={e}")
`);
    expect(status).toBe(200);
    expect(text).toContain("kv=KVBinding");
    expect(text).toContain("r2=R2Binding");
    expect(text).toContain("d1=D1Binding");
    expect(text).toContain("db=D1Binding");
    expect(text).toContain("kv2=KVBinding");
    expect(text).toContain("error=No binding or env var: NONEXISTENT");
  });
});
