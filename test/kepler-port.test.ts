import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

/**
 * Real-World Pattern Tests
 *
 * These tests validate that common Python patterns from production
 * applications work correctly in PyMode's workerd runtime.
 */

async function runPython(code: string): Promise<string> {
  const response = await SELF.fetch("http://localhost", {
    method: "POST",
    body: code,
  });
  return response.text();
}

// ---------------------------------------------------------------------------
// 1. Template variable extraction (from promptile parser)
// ---------------------------------------------------------------------------
describe("template variable extraction", () => {
  it("extracts {{variable}} patterns from templates", async () => {
    const result = await runPython(`
import re

def extract_variables(template):
    pattern = r'\\{\\{\\s*(\\w+)\\s*\\}\\}'
    return re.findall(pattern, template)

template = "Hello {{name}}, your order {{order_id}} is ready"
variables = extract_variables(template)
print(",".join(variables))
`);
    expect(result.trim()).toBe("name,order_id");
  });

  it("handles filter pipes like promptile processor", async () => {
    const result = await runPython(`
import re

def parse_variable_with_filters(expr):
    parts = expr.split('|')
    var_name = parts[0].strip()
    filters = [f.strip() for f in parts[1:]]
    return var_name, filters

var, filters = parse_variable_with_filters("username | upper | strip")
print(f"{var}:{','.join(filters)}")
`);
    expect(result.trim()).toBe("username:upper,strip");
  });

  it("parses conditional blocks like promptile", async () => {
    const result = await runPython(`
import re

template = "before {%if show_header%}HEADER{%endif%} after"
pattern = r'\\{%\\s*if\\s+(\\w+)\\s*%\\}(.*?)\\{%\\s*endif\\s*%\\}'
match = re.search(pattern, template)
if match:
    print(f"condition={match.group(1)},body={match.group(2)}")
`);
    expect(result.trim()).toBe("condition=show_header,body=HEADER");
  });

  it("parses for-loop blocks", async () => {
    const result = await runPython(`
import re

template = "{%for item in items%}* {{item}}{%endfor%}"
pattern = r'\\{%\\s*for\\s+(\\w+)\\s+in\\s+(\\w+)\\s*%\\}(.*?)\\{%\\s*endfor\\s*%\\}'
match = re.search(pattern, template)
if match:
    print(f"var={match.group(1)},iter={match.group(2)},body={match.group(3)}")
`);
    expect(result.trim()).toBe("var=item,iter=items,body=* {{item}}");
  });
});

// ---------------------------------------------------------------------------
// 2. Text sanitization
// ---------------------------------------------------------------------------
describe("text sanitization", () => {
  it("removes control characters", async () => {
    const result = await runPython(`
import re

def sanitize_text(text):
    text = re.sub(r'[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]', '', text)
    text = text.strip()
    return text

dirty = "Hello\\x00World\\x07Test\\x1f"
print(sanitize_text(dirty))
`);
    expect(result.trim()).toBe("HelloWorldTest");
  });

  it("normalizes whitespace", async () => {
    const result = await runPython(`
import re

def normalize_whitespace(text):
    return re.sub(r'\\s+', ' ', text).strip()

print(normalize_whitespace("  hello   world  \\n\\t foo  "))
`);
    expect(result.trim()).toBe("hello world foo");
  });
});

// ---------------------------------------------------------------------------
// 3. OOM detection
// ---------------------------------------------------------------------------
describe("OOM detection", () => {
  it("classifies error messages", async () => {
    const result = await runPython(`
import re

OOM_PATTERNS = [
    r'out of memory',
    r'memory allocation failed',
    r'MemoryError',
    r'OOM',
    r'cannot allocate',
]

def is_oom_error(message):
    for pattern in OOM_PATTERNS:
        if re.search(pattern, message, re.IGNORECASE):
            return True
    return False

errors = [
    "RuntimeError: out of memory",
    "MemoryError: cannot allocate 1GB",
    "ValueError: invalid input",
    "OOM killer invoked",
]
results = [str(is_oom_error(e)) for e in errors]
print(",".join(results))
`);
    expect(result.trim()).toBe("True,True,False,True");
  });
});

// ---------------------------------------------------------------------------
// 4. Schema validation (table column type checking)
// ---------------------------------------------------------------------------
describe("schema validation", () => {
  it("validates column types against schema", async () => {
    const result = await runPython(`
VALID_TYPES = {"str", "int", "float", "bool", "date", "datetime"}

def validate_schema(columns):
    errors = []
    for name, col_type in columns.items():
        if col_type not in VALID_TYPES:
            errors.append(f"{name}: unknown type '{col_type}'")
    return errors

schema = {
    "name": "str",
    "age": "int",
    "score": "float",
    "data": "json",
}
errors = validate_schema(schema)
print(";".join(errors))
`);
    expect(result.trim()).toBe("data: unknown type 'json'");
  });
});

// ---------------------------------------------------------------------------
// 5. Env file parsing
// ---------------------------------------------------------------------------
describe("env file parsing", () => {
  it("parses .env format with quotes and comments", async () => {
    const result = await runPython(`
import re

def parse_env(content):
    env = {}
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*)', line)
        if match:
            key = match.group(1)
            value = match.group(2).strip()
            if (value.startswith('"') and value.endswith('"')) or \\
               (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            env[key] = value
    return env

content = '''
# Database config
DB_HOST=localhost
DB_PORT=5432
API_KEY="sk-test-123"
DEBUG='true'
'''
result = parse_env(content)
parts = [f"{k}={v}" for k, v in sorted(result.items())]
print("|".join(parts))
`);
    expect(result.trim()).toBe("API_KEY=sk-test-123|DB_HOST=localhost|DB_PORT=5432|DEBUG=true");
  });
});

// ---------------------------------------------------------------------------
// 6. Dataclass models (pydantic replacement)
// ---------------------------------------------------------------------------
describe("dataclass models", () => {
  it("creates models with defaults and validation", async () => {
    const result = await runPython(`
from dataclasses import dataclass, field

@dataclass
class UserConfig:
    name: str
    email: str
    max_retries: int = 3
    tags: list = field(default_factory=list)

    def is_valid(self):
        return '@' in self.email and len(self.name) > 0

u1 = UserConfig(name="Alice", email="alice@example.com", tags=["admin"])
u2 = UserConfig(name="Bob", email="invalid")
print(f"{u1.is_valid()},{u2.is_valid()},{u1.max_retries},{u1.tags}")
`);
    expect(result.trim()).toBe("True,False,3,['admin']");
  });
});

// ---------------------------------------------------------------------------
// 7. LRU cache with TTL (OrderedDict-based)
// ---------------------------------------------------------------------------
describe("LRU cache", () => {
  it("implements TTL-based cache eviction", async () => {
    const result = await runPython(`
from collections import OrderedDict
import time

class TTLCache:
    def __init__(self, maxsize=100, ttl=60):
        self._cache = OrderedDict()
        self._maxsize = maxsize
        self._ttl = ttl

    def get(self, key):
        if key in self._cache:
            value, ts = self._cache[key]
            if time.time() - ts < self._ttl:
                self._cache.move_to_end(key)
                return value
            else:
                del self._cache[key]
        return None

    def put(self, key, value):
        if key in self._cache:
            del self._cache[key]
        elif len(self._cache) >= self._maxsize:
            self._cache.popitem(last=False)
        self._cache[key] = (value, time.time())

cache = TTLCache(maxsize=3, ttl=60)
cache.put("a", 1)
cache.put("b", 2)
cache.put("c", 3)
cache.put("d", 4)  # should evict "a"

results = [
    str(cache.get("a")),  # None (evicted)
    str(cache.get("b")),  # 2
    str(cache.get("d")),  # 4
]
print(",".join(results))
`);
    expect(result.trim()).toBe("None,2,4");
  });
});

// ---------------------------------------------------------------------------
// 8. XML parsing (xml.etree.ElementTree)
// ---------------------------------------------------------------------------
describe("XML parsing", () => {
  it("parses XML documents", async () => {
    const result = await runPython(`
import xml.etree.ElementTree as ET

xml_str = '''<?xml version="1.0"?>
<catalog>
  <book id="1">
    <title>Python Guide</title>
    <author>Alice</author>
  </book>
  <book id="2">
    <title>Zig Manual</title>
    <author>Bob</author>
  </book>
</catalog>'''

root = ET.fromstring(xml_str)
books = []
for book in root.findall('book'):
    title = book.find('title').text
    author = book.find('author').text
    bid = book.get('id')
    books.append(f"{bid}:{title}:{author}")
print("|".join(books))
`);
    expect(result.trim()).toBe("1:Python Guide:Alice|2:Zig Manual:Bob");
  });
});

// ---------------------------------------------------------------------------
// 9. Logging module
// ---------------------------------------------------------------------------
describe("logging module", () => {
  it("imports and works via threading shim", async () => {
    const result = await runPython(`
import logging
logger = logging.getLogger("test")
logger.setLevel(logging.INFO)
print(f"name={logger.name},level={logger.level}")
`);
    expect(result.trim()).toBe("name=test,level=20");
  });
});

// ---------------------------------------------------------------------------
// 10. Package import failures (expected)
// ---------------------------------------------------------------------------
describe("missing packages", () => {
  it("reports pydantic as unavailable", async () => {
    const result = await runPython(`
try:
    import pydantic
    print("AVAILABLE")
except ImportError:
    print("MISSING")
`);
    expect(result.trim()).toBe("MISSING");
  });

  it("reports yaml as unavailable", async () => {
    const result = await runPython(`
try:
    import yaml
    print("AVAILABLE")
except ImportError:
    print("MISSING")
`);
    expect(result.trim()).toBe("MISSING");
  });
});

// ---------------------------------------------------------------------------
// 11. UUID generation
// ---------------------------------------------------------------------------
describe("UUID generation", () => {
  it("generates valid uuid4 strings", async () => {
    const result = await runPython(`
import uuid
u = uuid.uuid4()
parts = str(u).split('-')
print(f"{len(parts)},{len(str(u))}")
`);
    expect(result.trim()).toBe("5,36");
  });
});

// ---------------------------------------------------------------------------
// 12. HMAC authentication
// ---------------------------------------------------------------------------
describe("HMAC authentication", () => {
  it("generates HMAC-SHA256 signatures", async () => {
    const result = await runPython(`
import hmac
import hashlib

secret = b"my-secret-key"
message = b"payload-to-sign"
sig = hmac.new(secret, message, hashlib.sha256).hexdigest()
valid = hmac.compare_digest(
    sig,
    hmac.new(secret, message, hashlib.sha256).hexdigest()
)
invalid = hmac.compare_digest(
    sig,
    hmac.new(b"wrong-key", message, hashlib.sha256).hexdigest()
)
print(f"len={len(sig)},valid={valid},invalid={invalid}")
`);
    expect(result.trim()).toBe("len=64,valid=True,invalid=False");
  });
});

// ---------------------------------------------------------------------------
// 13. URL building (urllib.parse)
// ---------------------------------------------------------------------------
describe("URL building", () => {
  it("constructs URLs with query parameters", async () => {
    const result = await runPython(`
from urllib.parse import urlencode, urlunparse, parse_qs, urlparse

params = {"q": "python wasm", "page": "1", "lang": "en"}
query = urlencode(params)
url = urlunparse(("https", "api.example.com", "/search", "", query, ""))

parsed = urlparse(url)
qs = parse_qs(parsed.query)
print(f"scheme={parsed.scheme},host={parsed.netloc},q={qs['q'][0]},page={qs['page'][0]}")
`);
    expect(result.trim()).toBe("scheme=https,host=api.example.com,q=python wasm,page=1");
  });
});

// ---------------------------------------------------------------------------
// 14. JSON response parsing (GraphQL-style)
// ---------------------------------------------------------------------------
describe("JSON response parsing", () => {
  it("extracts nested data from API responses", async () => {
    const result = await runPython(`
import json

response = json.loads('''{
    "data": {
        "users": [
            {"id": 1, "name": "Alice", "roles": ["admin", "user"]},
            {"id": 2, "name": "Bob", "roles": ["user"]}
        ]
    },
    "errors": null
}''')

users = response["data"]["users"]
admins = [u["name"] for u in users if "admin" in u["roles"]]
total = len(users)
print(f"total={total},admins={','.join(admins)}")
`);
    expect(result.trim()).toBe("total=2,admins=Alice");
  });
});

// ---------------------------------------------------------------------------
// 15. Stdlib availability scan
// ---------------------------------------------------------------------------
describe("stdlib availability", () => {
  it("checks essential stdlib modules", async () => {
    const result = await runPython(`
import importlib

modules = [
    "re", "json", "hashlib", "hmac", "uuid",
    "collections", "dataclasses", "functools", "itertools",
    "urllib.parse", "xml.etree.ElementTree", "logging",
    "io", "math", "time", "base64", "copy", "typing",
]

available = []
missing = []
for mod in modules:
    try:
        importlib.import_module(mod)
        available.append(mod)
    except ImportError:
        missing.append(mod)

print(f"available={len(available)},missing={len(missing)}")
if missing:
    print(f"missing_modules={','.join(missing)}")
`);
    const lines = result.trim().split("\n");
    expect(lines[0]).toMatch(/^available=\d+,missing=\d+$/);
  });
});
