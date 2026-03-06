// Integration tests for PyMode running inside the Cloudflare Workers runtime.
//
// Uses @cloudflare/vitest-pool-workers to run tests inside workerd with
// real miniflare-backed KV bindings. Every test here proves that python.wasm
// actually executes inside the Workers runtime — the same environment as production.

import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// Helper: POST Python code, get stdout back
async function runPython(code: string): Promise<{ text: string; status: number }> {
  const response = await SELF.fetch("http://localhost", {
    method: "POST",
    body: code,
  });
  const text = await response.text();
  return { text: text.trim(), status: response.status };
}

// ============================================================
// Basic Python execution (proves WASM runs in workerd)
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

  it("should handle tuples and unpacking", async () => {
    const { text } = await runPython(`
point = (3, 4)
x, y = point
print(x * x + y * y)
    `);
    expect(text).toContain("25");
  });

  it("should handle list comprehensions", async () => {
    const { text } = await runPython(`
squares = [x**2 for x in range(6)]
print(squares)
    `);
    expect(text).toContain("[0, 1, 4, 9, 16, 25]");
  });

  it("should handle dict comprehensions", async () => {
    const { text } = await runPython(`
d = {k: v for k, v in zip('abc', [1,2,3])}
print(d)
    `);
    expect(text).toContain("{'a': 1, 'b': 2, 'c': 3}");
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
    def speak(self):
        return "..."

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

  it("should support dataclass-like patterns", async () => {
    const { text } = await runPython(`
class Point:
    __slots__ = ('x', 'y')
    def __init__(self, x, y):
        self.x = x
        self.y = y
    def distance(self):
        return (self.x**2 + self.y**2) ** 0.5

p = Point(3, 4)
print(p.distance())
    `);
    expect(text).toContain("5.0");
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

  it("should use itertools module", async () => {
    const { text } = await runPython(`
import itertools
combos = list(itertools.combinations([1,2,3,4], 2))
print(len(combos))
perms = list(itertools.permutations([1,2,3]))
print(len(perms))
    `);
    expect(text).toContain("6");
    expect(text).toContain("6");
  });

  it("should use functools module", async () => {
    const { text } = await runPython(`
from functools import reduce
product = reduce(lambda a, b: a * b, [1, 2, 3, 4, 5])
print(product)
    `);
    expect(text).toContain("120");
  });

  it("should use hashlib module", async () => {
    const { text } = await runPython(`
import hashlib
h = hashlib.sha256(b"hello").hexdigest()
print(h[:16])
    `);
    expect(text).toContain("2cf24dba5fb0a30e");
  });

  it("should encode/decode bytes as hex", async () => {
    const { text } = await runPython(`
data = b"Hello, Workers!"
hex_str = data.hex()
print(hex_str)
restored = bytes.fromhex(hex_str).decode()
print(restored)
    `);
    expect(text).toContain("48656c6c6f2c20576f726b65727321");
    expect(text).toContain("Hello, Workers!");
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

  it("should generate random hex strings", async () => {
    const { text } = await runPython(`
import os
# Generate 16 random bytes, format as hex (like a UUID without dashes)
rand_bytes = os.urandom(16)
hex_str = rand_bytes.hex()
print(len(hex_str))
print(all(c in '0123456789abcdef' for c in hex_str))
    `);
    expect(text).toContain("32");
    expect(text).toContain("True");
  });

  it("should use textwrap module", async () => {
    const { text } = await runPython(`
import textwrap
wrapped = textwrap.fill("The quick brown fox jumps over the lazy dog", width=20)
lines = wrapped.split("\\n")
print(len(lines))
    `);
    const lineCount = parseInt(text);
    expect(lineCount).toBeGreaterThan(1);
  });

  it("should use string module", async () => {
    const { text } = await runPython(`
import string
print(string.ascii_lowercase)
print(len(string.digits))
    `);
    expect(text).toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("10");
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

  it("should handle custom exceptions", async () => {
    const { text } = await runPython(`
class AppError(Exception):
    def __init__(self, code, msg):
        self.code = code
        super().__init__(msg)

try:
    raise AppError(404, "not found")
except AppError as e:
    print(f"code={e.code} msg={e}")
    `);
    expect(text).toContain("code=404 msg=not found");
  });

  it("should report syntax errors", async () => {
    const { text, status } = await runPython("def foo(");
    expect(status).toBe(500);
  });

  it("should report runtime errors", async () => {
    const { text, status } = await runPython("print(undefined_var)");
    expect(status).toBe(500);
  });
});

// ============================================================
// Real-world patterns (JSON API, CSV, routing, validation)
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

  it("should parse delimited data", async () => {
    const { text } = await runPython(`
data = "name,age,city\\nAlice,30,NYC\\nBob,25,LA\\nCharlie,35,Chicago"
lines = data.strip().split("\\n")
headers = lines[0].split(",")
rows = [dict(zip(headers, line.split(","))) for line in lines[1:]]
print(len(rows))
print(rows[1]['name'])
total_age = sum(int(r['age']) for r in rows)
print(total_age)
    `);
    expect(text).toContain("3");
    expect(text).toContain("Bob");
    expect(text).toContain("90");
  });

  it("should implement URL routing", async () => {
    const { text } = await runPython(`
import re

routes = [
    (r'^/api/users/(?P<id>\\d+)$', 'get_user'),
    (r'^/api/users$', 'list_users'),
    (r'^/health$', 'health_check'),
]

def match_route(path):
    for pattern, handler in routes:
        m = re.match(pattern, path)
        if m:
            return handler, m.groupdict()
    return None, {}

handler, params = match_route("/api/users/42")
print(f"{handler} id={params.get('id')}")

handler2, _ = match_route("/health")
print(handler2)
    `);
    expect(text).toContain("get_user id=42");
    expect(text).toContain("health_check");
  });

  it("should validate data with schema-like pattern", async () => {
    const { text } = await runPython(`
def validate(data, schema):
    errors = []
    for field, rules in schema.items():
        value = data.get(field)
        if rules.get('required') and value is None:
            errors.append(f"{field} is required")
        elif value is not None:
            if 'type' in rules and not isinstance(value, rules['type']):
                errors.append(f"{field} must be {rules['type'].__name__}")
            if 'min' in rules and isinstance(value, (int, float)) and value < rules['min']:
                errors.append(f"{field} must be >= {rules['min']}")
    return errors

schema = {
    'name': {'required': True, 'type': str},
    'age': {'required': True, 'type': int, 'min': 0},
    'email': {'required': True, 'type': str},
}

errors = validate({'name': 'Alice', 'age': -5, 'email': 'a@b.com'}, schema)
print(errors)

errors2 = validate({'name': 'Bob'}, schema)
print(len(errors2))
    `);
    expect(text).toContain("age must be >= 0");
    expect(text).toContain("2"); // missing age and email
  });

  it("should process and transform nested data", async () => {
    const { text } = await runPython(`
import json

orders = [
    {"id": 1, "items": [{"product": "A", "qty": 2, "price": 10.0}]},
    {"id": 2, "items": [
        {"product": "B", "qty": 1, "price": 20.0},
        {"product": "C", "qty": 3, "price": 5.0},
    ]},
]

totals = []
for order in orders:
    total = sum(item["qty"] * item["price"] for item in order["items"])
    totals.append({"order_id": order["id"], "total": total})

print(json.dumps(totals))
    `);
    const totals = JSON.parse(text);
    expect(totals[0].total).toBe(20.0);
    expect(totals[1].total).toBe(35.0);
  });
});

// ============================================================
// Generators, decorators, context managers
// ============================================================
describe("Advanced Python features", () => {
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

  it("should use decorators", async () => {
    const { text } = await runPython(`
def memoize(fn):
    cache = {}
    def wrapper(*args):
        if args not in cache:
            cache[args] = fn(*args)
        return cache[args]
    wrapper.cache = cache
    return wrapper

@memoize
def factorial(n):
    return 1 if n <= 1 else n * factorial(n - 1)

print(factorial(20))
print(len(factorial.cache))
    `);
    expect(text).toContain("2432902008176640000");
  });

  it("should use context managers", async () => {
    const { text } = await runPython(`
class Timer:
    def __enter__(self):
        self.entered = True
        return self
    def __exit__(self, *args):
        self.exited = True
        return False

with Timer() as t:
    result = sum(range(1000))

print(result)
print(t.entered and t.exited)
    `);
    expect(text).toContain("499500");
    expect(text).toContain("True");
  });

  it("should use lambda and higher-order functions", async () => {
    const { text } = await runPython(`
data = [3, 1, 4, 1, 5, 9, 2, 6]
print(sorted(data))
print(sorted(data, key=lambda x: -x)[:3])
print(list(filter(lambda x: x > 3, data)))
print(list(map(lambda x: x * 2, [1, 2, 3])))
    `);
    expect(text).toContain("[1, 1, 2, 3, 4, 5, 6, 9]");
    expect(text).toContain("[9, 6, 5]");
    expect(text).toContain("[4, 5, 9, 6]");
    expect(text).toContain("[2, 4, 6]");
  });
});

// ============================================================
// Performance / stress (proves WASM is stable under load)
// ============================================================
describe("Stability", () => {
  it("should handle large data processing", async () => {
    const { text, status } = await runPython(`
data = list(range(10000))
total = sum(x * x for x in data)
print(total)
    `);
    expect(status).toBe(200);
    expect(text).toContain("333283335000");
  });

  it("should handle recursive algorithms", async () => {
    const { text } = await runPython(`
import sys
sys.setrecursionlimit(2000)

def mergesort(arr):
    if len(arr) <= 1:
        return arr
    mid = len(arr) // 2
    left = mergesort(arr[:mid])
    right = mergesort(arr[mid:])
    result = []
    i = j = 0
    while i < len(left) and j < len(right):
        if left[i] <= right[j]:
            result.append(left[i])
            i += 1
        else:
            result.append(right[j])
            j += 1
    result.extend(left[i:])
    result.extend(right[j:])
    return result

import random
random.seed(42)
data = [random.randint(0, 999) for _ in range(500)]
sorted_data = mergesort(data)
print(sorted_data == sorted(data))
print(len(sorted_data))
    `);
    expect(text).toContain("True");
    expect(text).toContain("500");
  });

  it("should handle multiple sequential requests", async () => {
    for (let i = 0; i < 3; i++) {
      const { text, status } = await runPython(`print(${i} * ${i})`);
      expect(status).toBe(200);
      expect(text).toContain(String(i * i));
    }
  });
});
