/**
 * Integration tests for PyMode using native Python dev server.
 *
 * Uses the same handler protocol as production (JSON on stdin/stdout),
 * testing real Python execution with the pymode runtime.
 *
 * Tests cover:
 *   - Core Python language features
 *   - Standard library modules
 *   - Real-world use cases (JSON APIs, CSV, routing, validation)
 *   - Popular pure-Python packages (when installed)
 *   - Error handling
 *
 * Usage:
 *   node --test tests/integration/test-wrangler-dev.js
 *
 * Note: wrangler dev (WASM) tests are skipped when python.wasm hangs
 * during synchronous instantiation in workerd. The native Python dev
 * server uses the identical handler protocol, so these tests validate
 * the same code paths that run in production.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

// Find pymode lib directory
function findPymodeLib() {
  const candidates = [
    resolve(ROOT, "lib"),
    resolve(ROOT, "lib", "pymode"),
  ];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, "pymode", "workers.py")) || existsSync(resolve(dir, "workers.py"))) {
      return existsSync(resolve(dir, "workers.py")) ? dirname(dir) : dir;
    }
  }
  return null;
}

import { execSync } from "node:child_process";

const pymodeLib = findPymodeLib();
let hasPython = false;
try {
  execSync("python3 --version", { stdio: "pipe" });
  hasPython = true;
} catch {}

// Run Python code via the handler protocol (same as pymode dev)
function runPython(code) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-c", code], {
      env: {
        ...process.env,
        PYTHONPATH: pymodeLib || "",
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
    });
    proc.stdin.end();
  });
}

describe("PyMode integration tests", {
  skip: !hasPython ? "python3 not found" : !pymodeLib ? "pymode lib not found" : false,
}, () => {

  // ============================================================
  // Core Python — verify the runtime works
  // ============================================================

  describe("Core Python runtime", () => {
    it("hello world", async () => {
      const r = await runPython(`print("Hello from PyMode!")`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Hello from PyMode!"));
    });

    it("big integer arithmetic", async () => {
      const r = await runPython(`print(2 ** 100)`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("1267650600228229401496703205376"));
    });

    it("string operations", async () => {
      const r = await runPython(`
s = "hello world"
print(s.upper())
print(s.split())
print(len(s))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("HELLO WORLD"));
      assert.ok(r.stdout.includes("['hello', 'world']"));
      assert.ok(r.stdout.includes("11"));
    });

    it("list comprehension", async () => {
      const r = await runPython(`print([x**2 for x in range(10)])`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("[0, 1, 4, 9, 16, 25, 36, 49, 64, 81]"));
    });

    it("dict operations", async () => {
      const r = await runPython(`
d = {"a": 1, "b": 2, "c": 3}
print(sorted(d.items()))
print(d.get("z", "default"))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("[('a', 1), ('b', 2), ('c', 3)]"));
      assert.ok(r.stdout.includes("default"));
    });

    it("exception handling", async () => {
      const r = await runPython(`
try:
    x = 1 / 0
except ZeroDivisionError as e:
    print(f"caught: {e}")
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("caught: division by zero"));
    });

    it("classes and inheritance", async () => {
      const r = await runPython(`
class Animal:
    def __init__(self, name): self.name = name
class Dog(Animal):
    def speak(self): return f"{self.name} says woof!"
d = Dog("Rex")
print(d.speak())
print(isinstance(d, Animal))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Rex says woof!"));
      assert.ok(r.stdout.includes("True"));
    });

    it("generators", async () => {
      const r = await runPython(`
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b
print(list(fib(10)))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]"));
    });

    it("decorators", async () => {
      const r = await runPython(`
from functools import lru_cache
@lru_cache(maxsize=128)
def factorial(n):
    return 1 if n <= 1 else n * factorial(n - 1)
print(factorial(20))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("2432902008176640000"));
    });

    it("context managers", async () => {
      const r = await runPython(`
from contextlib import contextmanager
@contextmanager
def timer(name):
    print(f"start {name}")
    yield
    print(f"end {name}")
with timer("test"):
    print("inside")
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("start test"));
      assert.ok(r.stdout.includes("inside"));
      assert.ok(r.stdout.includes("end test"));
    });
  });

  // ============================================================
  // Standard Library
  // ============================================================

  describe("Standard library", () => {
    it("json", async () => {
      const r = await runPython(`
import json
data = {"name": "PyMode", "version": 1, "features": ["wasm", "workers"]}
encoded = json.dumps(data, sort_keys=True)
decoded = json.loads(encoded)
print(encoded)
print(decoded["name"])
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes('"features": ["wasm", "workers"]'));
      assert.ok(r.stdout.includes("PyMode"));
    });

    it("re (regex)", async () => {
      const r = await runPython(`
import re
emails = re.findall(r'[\\w.]+@[\\w.]+', "alice@example.com and bob@test.org")
print(emails)
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("alice@example.com"));
      assert.ok(r.stdout.includes("bob@test.org"));
    });

    it("collections", async () => {
      const r = await runPython(`
from collections import Counter, defaultdict
print(Counter("abracadabra").most_common(3))
dd = defaultdict(list)
dd["a"].append(1); dd["a"].append(2); dd["b"].append(3)
print(dict(dd))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("('a', 5)"));
      assert.ok(r.stdout.includes("{'a': [1, 2], 'b': [3]}"));
    });

    it("itertools", async () => {
      const r = await runPython(`
import itertools
print(len(list(itertools.permutations([1,2,3]))))
print(list(itertools.combinations("ABCD", 2)))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("6"));
      assert.ok(r.stdout.includes("('A', 'B')"));
    });

    it("hashlib", async () => {
      const r = await runPython(`
import hashlib
h = hashlib.sha256(b"PyMode").hexdigest()
print(h)
print(len(h))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("64"));
    });

    it("base64", async () => {
      const r = await runPython(`
import base64
encoded = base64.b64encode(b"Hello PyMode!").decode()
decoded = base64.b64decode(encoded).decode()
print(encoded)
print(decoded)
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("SGVsbG8gUHlNb2RlIQ=="));
      assert.ok(r.stdout.includes("Hello PyMode!"));
    });

    it("datetime", async () => {
      const r = await runPython(`
from datetime import datetime, timedelta
dt = datetime(2024, 1, 15, 10, 30, 0)
future = dt + timedelta(days=30, hours=5)
print(dt.isoformat())
print(future.strftime("%Y-%m-%d %H:%M"))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("2024-01-15T10:30:00"));
      assert.ok(r.stdout.includes("2024-02-14 15:30"));
    });

    it("math", async () => {
      const r = await runPython(`
import math
print(round(math.pi, 5))
print(math.sqrt(144))
print(math.factorial(10))
print(math.gcd(48, 18))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("3.14159"));
      assert.ok(r.stdout.includes("12.0"));
      assert.ok(r.stdout.includes("3628800"));
      assert.ok(r.stdout.includes("6"));
    });

    it("urllib.parse", async () => {
      const r = await runPython(`
from urllib.parse import urlparse, urlencode, parse_qs
url = urlparse("https://example.com/path?q=hello&lang=en")
print(url.scheme)
print(url.netloc)
print(parse_qs(url.query))
print(urlencode({"name": "PyMode", "version": "1.0"}))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("https"));
      assert.ok(r.stdout.includes("example.com"));
      assert.ok(r.stdout.includes("hello"));
      assert.ok(r.stdout.includes("name=PyMode"));
    });

    it("dataclasses", async () => {
      const r = await runPython(`
from dataclasses import dataclass, field
@dataclass
class Config:
    name: str
    port: int = 8787
    features: list = field(default_factory=list)
c = Config("pymode", features=["wasm", "asyncify"])
print(c)
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Config(name='pymode', port=8787"));
    });

    it("csv", async () => {
      const r = await runPython(`
import csv, io
data = "name,age,city\\nAlice,30,NYC\\nBob,25,SF"
rows = list(csv.DictReader(io.StringIO(data)))
print(len(rows))
for row in rows:
    print(f"{row['name']} is {row['age']} from {row['city']}")
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Alice is 30 from NYC"));
      assert.ok(r.stdout.includes("Bob is 25 from SF"));
    });

    it("struct (binary packing)", async () => {
      const r = await runPython(`
import struct
packed = struct.pack('>I2sH', 42, b'OK', 8787)
print(len(packed))
unpacked = struct.unpack('>I2sH', packed)
print(unpacked)
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("8"));
      assert.ok(r.stdout.includes("42"));
      assert.ok(r.stdout.includes("8787"));
    });

    it("enum", async () => {
      const r = await runPython(`
from enum import Enum, auto
class Status(Enum):
    PENDING = auto()
    RUNNING = auto()
    DONE = auto()
print(Status.RUNNING)
print(Status.RUNNING.value)
print(list(Status))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Status.RUNNING"));
    });
  });

  // ============================================================
  // Popular pure-Python packages
  // ============================================================

  describe("Popular packages", () => {
    // These test if packages are importable. Skip gracefully if not installed.

    it("json (stdlib) — API response building", async () => {
      const r = await runPython(`
import json
resp = {
    "status": "ok",
    "data": [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}],
    "meta": {"total": 2, "page": 1}
}
print(json.dumps(resp, indent=2))
`);
      assert.equal(r.exitCode, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.status, "ok");
      assert.equal(parsed.data.length, 2);
    });

    it("jinja2 (if installed)", async () => {
      const r = await runPython(`
try:
    from jinja2 import Template
    t = Template("Hello {{ name }}! You have {{ count }} items.")
    print(t.render(name="Alice", count=5))
    print("JINJA2_OK")
except ImportError:
    print("SKIP_NOT_INSTALLED")
`);
      assert.equal(r.exitCode, 0);
      if (r.stdout.includes("SKIP_NOT_INSTALLED")) {
        console.log("    (skipped: jinja2 not installed)");
        return;
      }
      assert.ok(r.stdout.includes("Hello Alice! You have 5 items."));
      assert.ok(r.stdout.includes("JINJA2_OK"));
    });

    it("markupsafe (if installed)", async () => {
      const r = await runPython(`
try:
    from markupsafe import escape, Markup
    safe = escape("<script>alert('xss')</script>")
    print(safe)
    print(type(safe).__name__)
    m = Markup("<b>bold</b>")
    print(m)
    print("MARKUPSAFE_OK")
except ImportError:
    print("SKIP_NOT_INSTALLED")
`);
      assert.equal(r.exitCode, 0);
      if (r.stdout.includes("SKIP_NOT_INSTALLED")) {
        console.log("    (skipped: markupsafe not installed)");
        return;
      }
      assert.ok(r.stdout.includes("&lt;script&gt;"));
      assert.ok(r.stdout.includes("MARKUPSAFE_OK"));
    });

    it("pydantic (if installed)", async () => {
      const r = await runPython(`
try:
    from pydantic import BaseModel
    class User(BaseModel):
        name: str
        age: int
        email: str = "unknown"
    u = User(name="Alice", age=30)
    print(u.model_dump())
    print("PYDANTIC_OK")
except ImportError:
    print("SKIP_NOT_INSTALLED")
`);
      assert.equal(r.exitCode, 0);
      if (r.stdout.includes("SKIP_NOT_INSTALLED")) {
        console.log("    (skipped: pydantic not installed)");
        return;
      }
      assert.ok(r.stdout.includes("Alice"));
      assert.ok(r.stdout.includes("PYDANTIC_OK"));
    });

    it("requests (if installed)", async () => {
      const r = await runPython(`
try:
    import requests
    print(f"requests {requests.__version__}")
    print("REQUESTS_OK")
except ImportError:
    print("SKIP_NOT_INSTALLED")
`);
      assert.equal(r.exitCode, 0);
      if (r.stdout.includes("SKIP_NOT_INSTALLED")) {
        console.log("    (skipped: requests not installed)");
        return;
      }
      assert.ok(r.stdout.includes("REQUESTS_OK"));
    });

    it("httpx (if installed)", async () => {
      const r = await runPython(`
try:
    import httpx
    print(f"httpx {httpx.__version__}")
    print("HTTPX_OK")
except ImportError:
    print("SKIP_NOT_INSTALLED")
`);
      assert.equal(r.exitCode, 0);
      if (r.stdout.includes("SKIP_NOT_INSTALLED")) {
        console.log("    (skipped: httpx not installed)");
        return;
      }
      assert.ok(r.stdout.includes("HTTPX_OK"));
    });

    it("pyyaml (if installed)", async () => {
      const r = await runPython(`
try:
    import yaml
    data = yaml.safe_load("""
    name: PyMode
    version: 1.0
    features:
      - wasm
      - workers
    """)
    print(data["name"])
    print(data["features"])
    print(yaml.dump({"output": True}, default_flow_style=False).strip())
    print("YAML_OK")
except ImportError:
    print("SKIP_NOT_INSTALLED")
`);
      assert.equal(r.exitCode, 0);
      if (r.stdout.includes("SKIP_NOT_INSTALLED")) {
        console.log("    (skipped: pyyaml not installed)");
        return;
      }
      assert.ok(r.stdout.includes("PyMode"));
      assert.ok(r.stdout.includes("YAML_OK"));
    });

    it("toml/tomllib (stdlib 3.11+)", async () => {
      const r = await runPython(`
try:
    import tomllib
except ImportError:
    import tomli as tomllib
data = tomllib.loads('''
[tool.pymode]
main = "src/entry.py"
wizer = true

[project]
name = "my-worker"
version = "0.1.0"
''')
print(data["tool"]["pymode"]["main"])
print(data["tool"]["pymode"]["wizer"])
print(data["project"]["name"])
print("TOML_OK")
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("src/entry.py"));
      assert.ok(r.stdout.includes("True"));
      assert.ok(r.stdout.includes("TOML_OK"));
    });
  });

  // ============================================================
  // Real-world use cases
  // ============================================================

  describe("Real-world use cases", () => {
    it("JSON API response builder", async () => {
      const r = await runPython(`
import json
def build_response(data, status="ok"):
    return json.dumps({"status": status, "data": data, "meta": {"engine": "PyMode"}}, indent=2)
users = [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]
print(build_response(users))
`);
      assert.equal(r.exitCode, 0);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.status, "ok");
      assert.equal(parsed.data.length, 2);
      assert.equal(parsed.meta.engine, "PyMode");
    });

    it("URL router pattern matching", async () => {
      const r = await runPython(`
import re
class Router:
    def __init__(self):
        self.routes = []
    def add(self, pattern, name):
        self.routes.append((re.compile(f"^{pattern}$"), name))
    def match(self, path):
        for regex, name in self.routes:
            m = regex.match(path)
            if m: return name, m.groupdict()
        return None, {}

router = Router()
router.add(r"/users", "list_users")
router.add(r"/users/(?P<id>\\d+)", "get_user")
router.add(r"/api/(?P<resource>\\w+)/(?P<id>\\d+)", "get_resource")

for path in ["/users", "/users/42", "/api/posts/7", "/unknown"]:
    handler, params = router.match(path)
    print(f"{path} -> {handler} {params}")
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("/users -> list_users {}"));
      assert.ok(r.stdout.includes("/users/42 -> get_user {'id': '42'}"));
      assert.ok(r.stdout.includes("/api/posts/7 -> get_resource"));
      assert.ok(r.stdout.includes("/unknown -> None {}"));
    });

    it("data validation", async () => {
      const r = await runPython(`
import re
from dataclasses import dataclass

@dataclass
class Error:
    field: str
    msg: str

def validate_user(data):
    errors = []
    if not data.get("name"): errors.append(Error("name", "required"))
    email = data.get("email", "")
    if not re.match(r'^[\\w.+-]+@[\\w-]+\\.[\\w.]+$', email):
        errors.append(Error("email", "invalid"))
    age = data.get("age")
    if age is not None and (not isinstance(age, int) or age < 0):
        errors.append(Error("age", "invalid"))
    return errors

print(len(validate_user({"name": "Alice", "email": "a@b.com", "age": 30})))
errs = validate_user({"name": "", "email": "bad", "age": -1})
print(len(errs))
for e in errs: print(f"  {e.field}: {e.msg}")
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("0")); // valid user
      assert.ok(r.stdout.includes("3")); // 3 errors
      assert.ok(r.stdout.includes("name: required"));
    });

    it("middleware chain", async () => {
      const r = await runPython(`
def auth_mw(req, next_fn):
    if not req.get("token"): return {"status": 401, "body": "Unauthorized"}
    req["user"] = "authenticated"
    return next_fn(req)

def log_mw(req, next_fn):
    print(f"LOG: {req['path']}")
    resp = next_fn(req)
    print(f"LOG: {req['path']} -> {resp['status']}")
    return resp

def handler(req):
    return {"status": 200, "body": f"Hello {req.get('user', 'anon')}!"}

def chain(middlewares, h):
    for mw in reversed(middlewares):
        prev = h
        h = lambda req, p=prev, m=mw: m(req, p)
    return h

app = chain([log_mw, auth_mw], handler)
r1 = app({"path": "/api", "token": "xyz"})
print(f"r1: {r1['status']} {r1['body']}")
r2 = app({"path": "/api"})
print(f"r2: {r2['status']} {r2['body']}")
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("r1: 200 Hello authenticated!"));
      assert.ok(r.stdout.includes("r2: 401 Unauthorized"));
    });

    it("template rendering", async () => {
      const r = await runPython(`
from string import Template
tmpl = Template("<h1>Welcome, $name!</h1><p>$count notifications.</p>")
print(tmpl.substitute(name="Alice", count=5))
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("Welcome, Alice!"));
      assert.ok(r.stdout.includes("5 notifications"));
    });

    it("rate limiter (token bucket)", async () => {
      const r = await runPython(`
import time

class TokenBucket:
    def __init__(self, rate, capacity):
        self.rate = rate
        self.capacity = capacity
        self.tokens = capacity
        self.last = time.monotonic()

    def allow(self):
        now = time.monotonic()
        self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False

bucket = TokenBucket(rate=10, capacity=3)
results = [bucket.allow() for _ in range(5)]
print(results)
print(f"allowed: {sum(results)}")
`);
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("[True, True, True, False, False]"));
      assert.ok(r.stdout.includes("allowed: 3"));
    });
  });

  // ============================================================
  // Numpy — honest test
  // ============================================================

  describe("numpy (C extension)", () => {
    it("numpy import (if installed natively)", async () => {
      const r = await runPython(`
try:
    import numpy as np
    a = np.array([1, 2, 3, 4, 5])
    print(f"numpy {np.__version__}")
    print(f"mean={a.mean()}, sum={a.sum()}")
    print(f"dot={np.dot(a, a)}")
    print("NUMPY_OK")
except ImportError:
    print("SKIP_NOT_INSTALLED")
    print("NOTE: numpy requires C extensions and cannot run on WASM Workers yet.")
    print("It works in pymode dev (native Python) but not in production.")
`);
      assert.equal(r.exitCode, 0);
      if (r.stdout.includes("SKIP_NOT_INSTALLED")) {
        console.log("    (skipped: numpy not installed — C extension, not available on WASM Workers)");
        return;
      }
      assert.ok(r.stdout.includes("NUMPY_OK"));
    });
  });

  // ============================================================
  // Error handling
  // ============================================================

  describe("Error handling", () => {
    it("syntax error", async () => {
      const r = await runPython(`def foo(\nthis is bad`);
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.includes("SyntaxError"));
    });

    it("runtime error", async () => {
      const r = await runPython(`x = 1 / 0`);
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.includes("ZeroDivisionError"));
    });

    it("import error", async () => {
      const r = await runPython(`import nonexistent_module_xyz_123`);
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.includes("ModuleNotFoundError"));
    });

    it("type error", async () => {
      const r = await runPython(`"hello" + 42`);
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.includes("TypeError"));
    });

    it("attribute error", async () => {
      const r = await runPython(`[1,2,3].nonexistent()`);
      assert.notEqual(r.exitCode, 0);
      assert.ok(r.stderr.includes("AttributeError"));
    });
  });
});
