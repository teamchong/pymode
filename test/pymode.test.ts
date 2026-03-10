// Integration tests for PyMode — exercises the full production path:
//   HTTP POST → Worker → PythonDO (RPC) → Asyncify → python.wasm → exec code
//
// Requires: wrangler dev running (started by test/setup.ts globalSetup)

import { describe, it, expect } from "vitest";
import { runPython } from "./helpers";

// ============================================================
// Basic Python execution (proves Worker → DO → WASM pipeline)
// ============================================================
describe("WASM execution", () => {
  it("should run print()", async () => {
    const { text, status } = await runPython("print('hello from wasm')");
    expect(status).toBe(200);
    expect(text).toContain("hello from wasm");
  });

  it("should evaluate arithmetic", async () => {
    const { text } = await runPython("print(2 + 3)");
    expect(text).toContain("5");
  });

  it("should handle string operations", async () => {
    const { text } = await runPython("print('hello world'.upper())");
    expect(text).toContain("HELLO WORLD");
  });

  it("should run multi-line code", async () => {
    const { text } = await runPython(`
x = 10
y = 20
print(x + y)
    `);
    expect(text).toContain("30");
  });

  it("should handle f-strings", async () => {
    const { text } = await runPython(`
name = "PyMode"
version = 1
print(f"{name} v{version}")
    `);
    expect(text).toContain("PyMode v1");
  });
});

// ============================================================
// Python data structures
// ============================================================
describe("Data structures", () => {
  it("should handle lists", async () => {
    const { text } = await runPython(`
nums = [1, 2, 3, 4, 5]
print(sum(nums))
print(len(nums))
    `);
    expect(text).toContain("15");
    expect(text).toContain("5");
  });

  it("should handle dicts", async () => {
    const { text } = await runPython(`
d = {"a": 1, "b": 2, "c": 3}
print(sorted(d.keys()))
print(sum(d.values()))
    `);
    expect(text).toContain("['a', 'b', 'c']");
    expect(text).toContain("6");
  });

  it("should handle sets", async () => {
    const { text } = await runPython(`
a = {1, 2, 3}
b = {2, 3, 4}
print(sorted(a & b))
print(sorted(a | b))
    `);
    expect(text).toContain("[2, 3]");
    expect(text).toContain("[1, 2, 3, 4]");
  });

  it("should handle list comprehensions", async () => {
    const { text } = await runPython(`
squares = [x**2 for x in range(6)]
print(squares)
    `);
    expect(text).toContain("[0, 1, 4, 9, 16, 25]");
  });
});

// ============================================================
// Standard library modules
// ============================================================
describe("Standard library", () => {
  it("should use json module", async () => {
    const { text } = await runPython(`
import json
data = {"name": "PyMode", "version": 1, "features": ["wasm", "workers"]}
s = json.dumps(data, sort_keys=True)
parsed = json.loads(s)
print(parsed["name"])
print(len(parsed["features"]))
    `);
    expect(text).toContain("PyMode");
    expect(text).toContain("2");
  });

  it("should use re module", async () => {
    const { text } = await runPython(`
import re
emails = "contact alice@example.com or bob@test.org for info"
found = re.findall(r'[\\w.]+@[\\w.]+', emails)
print(len(found))
print(found[0])
    `);
    expect(text).toContain("2");
    expect(text).toContain("alice@example.com");
  });

  it("should use math module", async () => {
    const { text } = await runPython(`
import math
print(math.factorial(10))
print(round(math.pi, 5))
print(math.gcd(48, 18))
    `);
    expect(text).toContain("3628800");
    expect(text).toContain("3.14159");
    expect(text).toContain("6");
  });

  it("should use collections module", async () => {
    const { text } = await runPython(`
from collections import Counter, defaultdict
c = Counter("abracadabra")
print(c.most_common(3))

dd = defaultdict(list)
dd["a"].append(1)
dd["a"].append(2)
print(dict(dd))
    `);
    expect(text).toContain("a");
    expect(text).toContain("'a': [1, 2]");
  });

  it("should use hashlib module", async () => {
    const { text } = await runPython(`
import hashlib
h = hashlib.sha256(b"hello").hexdigest()
print(h[:16])
    `);
    expect(text).toContain("2cf24dba5fb0a30e");
  });

  it("should use datetime module", async () => {
    const { text } = await runPython(`
from datetime import datetime, timedelta
dt = datetime(2024, 1, 15, 12, 0, 0)
future = dt + timedelta(days=30)
print(future.strftime("%Y-%m-%d"))
    `);
    expect(text).toContain("2024-02-14");
  });

  it("should write and list files in /tmp", async () => {
    const { text } = await runPython(`
import tempfile
import os

fd, path = tempfile.mkstemp(suffix='.txt', dir='/tmp')
os.write(fd, b'hello tmp')
os.close(fd)

entries = os.listdir('/tmp')
basename = os.path.basename(path)
print(basename in entries)

with open(path) as f:
    print(f.read())

os.unlink(path)
print('OK')
    `);
    expect(text).toContain("True");
    expect(text).toContain("hello tmp");
    expect(text).toContain("OK");
  });
});

// ============================================================
// Classes and OOP
// ============================================================
describe("Classes and OOP", () => {
  it("should define and use classes", async () => {
    const { text } = await runPython(`
class Dog:
    def __init__(self, name):
        self.name = name
    def speak(self):
        return f"{self.name} says woof!"

d = Dog("Rex")
print(d.speak())
    `);
    expect(text).toContain("Rex says woof!");
  });

  it("should support inheritance", async () => {
    const { text } = await runPython(`
class Animal:
    def __init__(self, name):
        self.name = name

class Cat(Animal):
    def speak(self):
        return f"{self.name} says meow!"

c = Cat("Whiskers")
print(c.speak())
print(isinstance(c, Animal))
    `);
    expect(text).toContain("Whiskers says meow!");
    expect(text).toContain("True");
  });
});

// ============================================================
// Error handling
// ============================================================
describe("Error handling", () => {
  it("should handle try/except", async () => {
    const { text } = await runPython(`
try:
    x = 1 / 0
except ZeroDivisionError as e:
    print(f"caught: {e}")
    `);
    expect(text).toContain("caught: division by zero");
  });

  it("should report syntax errors", async () => {
    const { status } = await runPython("def foo(");
    expect(status).toBe(500);
  });

  it("should report runtime errors", async () => {
    const { status } = await runPython("print(undefined_var)");
    expect(status).toBe(500);
  });
});

// ============================================================
// Real-world patterns
// ============================================================
describe("Real-world patterns", () => {
  it("should build a JSON API response", async () => {
    const { text } = await runPython(`
import json
users = [
    {"id": 1, "name": "Alice", "email": "alice@example.com"},
    {"id": 2, "name": "Bob", "email": "bob@example.com"},
]
response = json.dumps({"users": users, "count": len(users)})
print(response)
    `);
    const data = JSON.parse(text);
    expect(data.count).toBe(2);
    expect(data.users[0].name).toBe("Alice");
  });

  it("should use generators", async () => {
    const { text } = await runPython(`
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b

print(list(fib(10)))
    `);
    expect(text).toContain("[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]");
  });

  it("should handle large data processing", async () => {
    const { text, status } = await runPython(`
data = list(range(10000))
total = sum(x * x for x in data)
print(total)
    `);
    expect(status).toBe(200);
    expect(text).toContain("333283335000");
  });
});
