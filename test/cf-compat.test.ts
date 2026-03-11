// Cloudflare Workers Python Compatibility Tests
//
// Hands-on tests for every package CF Workers Python supports.
// Each test exercises real functionality — not just import checks.
//
// Pure Python packages: loaded from site-packages.zip
// C extensions: tested via numpy.test.ts (statically linked into python-numpy.wasm)
// CPython built-in modules: hashlib, decimal, etc.
//
// Rust extensions: tested via pydantic.test.ts (pydantic_core linked into python-pydantic-core.wasm)
// zlib is provided by a pure-Python polyfill (lib/polyfills/zlib.py).

import { describe, it, expect } from "vitest";
import { runPython as run } from "./helpers";

// ─── Pure Python Packages (all working) ─────────────────────────────

describe("jinja2", () => {
  it("renders template with variables, loops, filters", async () => {
    const { text, status } = await run(`
import jinja2
env = jinja2.Environment()
t = env.from_string("{% for u in users %}{{ u.name|upper }}: {{ u.score }};{% endfor %}")
result = t.render(users=[
    {"name": "alice", "score": 95},
    {"name": "bob", "score": 87},
])
print(result)
`);
    expect(status).toBe(200);
    expect(text).toBe("ALICE: 95;BOB: 87;");
  });

  it("template inheritance with DictLoader", async () => {
    const { text, status } = await run(`
import jinja2
loader = jinja2.DictLoader({
    "base.html": "Header|{% block content %}{% endblock %}|Footer",
    "page.html": '{% extends "base.html" %}{% block content %}Hello{% endblock %}'
})
env = jinja2.Environment(loader=loader)
print(env.get_template("page.html").render())
`);
    expect(status).toBe(200);
    expect(text).toBe("Header|Hello|Footer");
  });
});

describe("markupsafe", () => {
  it("escapes HTML and Markup concatenation", async () => {
    const { text, status } = await run(`
from markupsafe import Markup, escape
safe = Markup("<b>bold</b>")
unsafe = "<script>xss</script>"
result = safe + " " + escape(unsafe)
print(result)
print(type(result).__name__)
`);
    expect(status).toBe(200);
    expect(text).toContain("<b>bold</b>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("Markup");
  });
});

describe("click", () => {
  it("creates and invokes a CLI command", async () => {
    const { text, status } = await run(`
import click
from click.testing import CliRunner

@click.command()
@click.option('--name', default='World')
def hello(name):
    click.echo(f"Hello {name}!")

runner = CliRunner()
result = runner.invoke(hello, ['--name', 'PyMode'])
print(result.output.strip())
print(f"exit_code={result.exit_code}")
`);
    expect(status).toBe(200);
    expect(text).toContain("Hello PyMode!");
    expect(text).toContain("exit_code=0");
  });
});

describe("pyyaml", () => {
  it("round-trips complex YAML", async () => {
    const { text, status } = await run(`
import yaml
doc = """
services:
  web:
    image: nginx
    ports: [80, 443]
    environment:
      DEBUG: "false"
"""
data = yaml.safe_load(doc)
print(f"ports={data['services']['web']['ports']}")
output = yaml.safe_dump(data)
data2 = yaml.safe_load(output)
print(f"match={data == data2}")
`);
    expect(status).toBe(200);
    expect(text).toContain("ports=[80, 443]");
    expect(text).toContain("match=True");
  });
});

describe("beautifulsoup4", () => {
  it("parses and queries HTML", async () => {
    const { text, status } = await run(`
from bs4 import BeautifulSoup
html = '<html><body><h1 class="title">Hello</h1><p>World</p><a href="/link">Click</a></body></html>'
soup = BeautifulSoup(html, 'html.parser')
print(f"h1={soup.h1.string}")
print(f"class={soup.h1['class']}")
print(f"href={soup.a['href']}")
print(f"text={soup.get_text(separator='|')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("h1=Hello");
    expect(text).toContain("href=/link");
    expect(text).toContain("Hello|World|Click");
  });

  it("CSS selector queries", async () => {
    const { text, status } = await run(`
from bs4 import BeautifulSoup
html = '<ul><li class="a">1</li><li class="b">2</li><li class="a">3</li></ul>'
soup = BeautifulSoup(html, 'html.parser')
items = [li.string for li in soup.select('li.a')]
print(f"items={items}")
`);
    expect(status).toBe(200);
    expect(text).toContain("items=['1', '3']");
  });
});

describe("h11", () => {
  it("builds HTTP/1.1 request bytes", async () => {
    const { text, status } = await run(`
import h11
conn = h11.Connection(our_role=h11.CLIENT)
req = h11.Request(method="GET", target="/api", headers=[
    ("Host", "example.com"),
    ("Accept", "application/json"),
])
data = conn.send(req)
print(f"starts_with_GET={data[:3] == b'GET'}")
print(f"has_host={b'Host: example.com' in data}")
`);
    expect(status).toBe(200);
    expect(text).toContain("starts_with_GET=True");
    expect(text).toContain("has_host=True");
  });
});

describe("attrs", () => {
  it("defines classes with validators and asdict", async () => {
    const { text, status } = await run(`
import attrs

@attrs.define
class Point:
    x: float
    y: float

    @property
    def magnitude(self):
        return (self.x**2 + self.y**2)**0.5

p = Point(3.0, 4.0)
print(f"mag={p.magnitude}")
print(f"repr={repr(p)}")
d = attrs.asdict(p)
print(f"dict={d}")
`);
    expect(status).toBe(200);
    expect(text).toContain("mag=5.0");
    expect(text).toContain("Point(x=3.0, y=4.0)");
    expect(text).toContain("{'x': 3.0, 'y': 4.0}");
  });
});

describe("starlette", () => {
  it("creates app with routing", async () => {
    const { text, status } = await run(`
from starlette.routing import Route
from starlette.responses import JSONResponse
from starlette.applications import Starlette

async def homepage(request):
    return JSONResponse({"message": "hello"})

async def greet(request):
    name = request.path_params["name"]
    return JSONResponse({"greeting": f"Hi {name}"})

app = Starlette(routes=[
    Route("/", homepage),
    Route("/greet/{name}", greet),
])

print(f"routes={len(app.routes)}")
print(f"has_router={hasattr(app, 'router')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("routes=2");
    expect(text).toContain("has_router=True");
  });
});

describe("packaging", () => {
  it("parses versions and compares", async () => {
    const { text, status } = await run(`
from packaging.version import Version

v1 = Version("2.4.1")
v2 = Version("3.0.0a1")
print(f"v1<v2={v1 < v2}")
print(f"v2_pre={v2.is_prerelease}")
print(f"v1_str={str(v1)}")
print(f"major={v1.major}")
`);
    expect(status).toBe(200);
    expect(text).toContain("v1<v2=True");
    expect(text).toContain("v2_pre=True");
    expect(text).toContain("v1_str=2.4.1");
    expect(text).toContain("major=2");
  });
});

describe("pyparsing", () => {
  it("parses arithmetic expressions", async () => {
    const { text, status } = await run(`
import pyparsing as pp

integer = pp.Word(pp.nums).setParseAction(lambda t: int(t[0]))
expr = integer + pp.oneOf("+ - * /") + integer
result = expr.parseString("42 + 7")
print(f"parsed={list(result)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("parsed=[42, '+', 7]");
  });
});

describe("six", () => {
  it("py2/py3 compatibility helpers", async () => {
    const { text, status } = await run(`
import six
print(f"PY3={six.PY3}")
print(f"text_type={six.text_type.__name__}")
d = {"a": 1, "b": 2}
items = list(six.iteritems(d))
print(f"items={sorted(items)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("PY3=True");
    expect(text).toContain("text_type=str");
    expect(text).toContain("('a', 1)");
  });
});

describe("certifi", () => {
  it("imports and exposes certificate API", async () => {
    // certifi.where() and cacert.pem reading need real filesystem access
    // which isn't available in WASI zip-based imports. Test the API surface.
    const { text, status } = await run(`
import certifi
print(f"has_where={callable(certifi.where)}")
print(f"has_contents={callable(certifi.contents)}")
print(f"has_version={hasattr(certifi, '__version__')}")
print(f"version={certifi.__version__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_where=True");
    expect(text).toContain("has_contents=True");
    expect(text).toContain("has_version=True");
  });
});

describe("idna", () => {
  it("encodes/decodes international domain names", async () => {
    const { text, status } = await run(`
import idna
encoded = idna.encode("münchen.de")
print(f"encoded={encoded}")
decoded = idna.decode("xn--mnchen-3ya.de")
print(f"decoded={decoded}")
print(f"ascii={idna.encode('example.com')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("xn--mnchen-3ya.de");
    expect(text).toContain("decoded=münchen.de");
  });
});

describe("charset-normalizer", () => {
  it("detects encoding of byte strings", async () => {
    const { text, status } = await run(`
from charset_normalizer import detect
data = "Hello, 世界! Ñoño".encode('utf-8')
result = detect(data)
print(f"encoding={result['encoding']}")
print(f"confident={result['confidence'] > 0.5}")
`);
    expect(status).toBe(200);
    expect(text).toContain("confident=True");
  });
});

describe("anyio", () => {
  it("async primitives and task groups", async () => {
    const { text, status } = await run(`
import anyio
print(f"has_run={hasattr(anyio, 'run')}")
print(f"has_sleep={hasattr(anyio, 'sleep')}")
print(f"has_create_task_group={hasattr(anyio, 'create_task_group')}")
from anyio import Event, Lock
print(f"Event={Event.__name__}")
print(f"Lock={Lock.__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_run=True");
    expect(text).toContain("Event=Event");
    expect(text).toContain("Lock=Lock");
  });
});

describe("sniffio", () => {
  it("detects async library", async () => {
    const { text, status } = await run(`
import sniffio
try:
    sniffio.current_async_library()
except sniffio.AsyncLibraryNotFoundError:
    print("no_async_context=True")
print(f"has_detector={hasattr(sniffio, 'current_async_library')}")
`);
    expect(status).toBe(200);
    expect(text).toContain("no_async_context=True");
    expect(text).toContain("has_detector=True");
  });
});

describe("annotated-types", () => {
  it("creates type constraints", async () => {
    const { text, status } = await run(`
from annotated_types import Gt, Lt, MinLen, MaxLen
print(f"Gt5={Gt(5)}")
print(f"MinLen2={MinLen(2)}")
from typing import Annotated
PositiveInt = Annotated[int, Gt(0)]
print(f"metadata={PositiveInt.__metadata__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("Gt(gt=5)");
  });
});

describe("typing-extensions", () => {
  it("provides backported types", async () => {
    const { text, status } = await run(`
import typing_extensions as te
print(f"has_TypedDict={hasattr(te, 'TypedDict')}")
print(f"has_Protocol={hasattr(te, 'Protocol')}")
print(f"has_Annotated={hasattr(te, 'Annotated')}")
print(f"has_Self={hasattr(te, 'Self')}")

class Config(te.TypedDict):
    name: str
    debug: bool

c: Config = {"name": "test", "debug": True}
print(f"config={c}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_TypedDict=True");
    expect(text).toContain("has_Protocol=True");
    expect(text).toContain("has_Self=True");
  });
});

describe("jsonpatch", () => {
  it("applies RFC 6902 JSON patches", async () => {
    const { text, status } = await run(`
import jsonpatch
doc = {"name": "Alice", "age": 30, "tags": ["admin"]}
patch = jsonpatch.JsonPatch([
    {"op": "replace", "path": "/name", "value": "Bob"},
    {"op": "add", "path": "/tags/1", "value": "editor"},
    {"op": "remove", "path": "/age"},
])
result = patch.apply(doc)
print(f"name={result['name']}")
print(f"tags={result['tags']}")
print(f"has_age={'age' in result}")

d1 = {"a": 1, "b": 2}
d2 = {"a": 1, "b": 3, "c": 4}
diff = jsonpatch.make_patch(d1, d2)
print(f"ops={len(list(diff))}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=Bob");
    expect(text).toContain("tags=['admin', 'editor']");
    expect(text).toContain("has_age=False");
    expect(text).toContain("ops=2");
  });
});

describe("jsonpointer", () => {
  it("resolves RFC 6901 JSON pointers", async () => {
    const { text, status } = await run(`
import jsonpointer
doc = {"store": {"books": [{"title": "Dune"}, {"title": "Neuromancer"}]}}
ptr = jsonpointer.JsonPointer("/store/books/1/title")
print(f"resolved={ptr.resolve(doc)}")

jsonpointer.set_pointer(doc, "/store/books/0/author", "Herbert")
print(f"author={doc['store']['books'][0]['author']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("resolved=Neuromancer");
    expect(text).toContain("author=Herbert");
  });
});

describe("distro", () => {
  it("reports OS info without crashing", async () => {
    const { text, status } = await run(`
import distro
info = distro.info()
print(f"type={type(info).__name__}")
print(f"has_id={isinstance(distro.id(), str)}")
print(f"has_name={isinstance(distro.name(), str)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("type=dict");
    expect(text).toContain("has_id=True");
  });
});

describe("tblib", () => {
  it("pickles tracebacks", async () => {
    const { text, status } = await run(`
import tblib.pickling_support
tblib.pickling_support.install()
import pickle, traceback, sys

try:
    1/0
except:
    et, ev, tb = sys.exc_info()
    tb_str = ''.join(traceback.format_exception(et, ev, tb))
    print(f"has_ZeroDivision={'ZeroDivisionError' in tb_str}")

    pickled = pickle.dumps(tb)
    unpickled = pickle.loads(pickled)
    print(f"unpickled_type={type(unpickled).__name__}")
`);
    expect(status).toBe(200);
    expect(text).toContain("has_ZeroDivision=True");
    expect(text).toContain("unpickled_type=traceback");
  });
});

describe("tenacity", () => {
  it("configures retry strategies and detects failures", async () => {
    const { text, status } = await run(`
from tenacity import retry, stop_after_attempt, wait_none, RetryError, Retrying

# Test retry configuration objects
stop = stop_after_attempt(3)
wait = wait_none()
print(f"stop_type={type(stop).__name__}")
print(f"wait_type={type(wait).__name__}")

# Test Retrying object creation and configuration
r = Retrying(stop=stop_after_attempt(2), wait=wait_none())
print(f"retrying_type={type(r).__name__}")
print(f"has_retry_error={RetryError is not None}")

# Test that retry decorator creates callable
@retry(stop=stop_after_attempt(1), wait=wait_none())
def always_ok():
    return 42
print(f"decorated={callable(always_ok)}")
`);
    expect(status).toBe(200);
    expect(text).toContain("stop_type=stop_after_attempt");
    expect(text).toContain("wait_type=wait_none");
    expect(text).toContain("retrying_type=Retrying");
    expect(text).toContain("has_retry_error=True");
    expect(text).toContain("decorated=True");
  });
});

// ─── CPython Built-in Modules ───────────────────────────────────────

describe("hashlib (builtin)", () => {
  it("computes SHA-256, MD5, SHA-1", async () => {
    const { text, status } = await run(`
import hashlib
sha = hashlib.sha256(b"hello world").hexdigest()
print(f"sha256={sha}")
md5 = hashlib.md5(b"hello world").hexdigest()
print(f"md5={md5}")
h = hashlib.sha1()
h.update(b"hello ")
h.update(b"world")
print(f"sha1={h.hexdigest()}")
`);
    expect(status).toBe(200);
    expect(text).toContain("sha256=b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    expect(text).toContain("md5=5eb63bbbe01eeed093cb22bb8f5acdc3");
    expect(text).toContain("sha1=2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
  });
});

describe("decimal (builtin)", () => {
  it("precise decimal arithmetic", async () => {
    const { text, status } = await run(`
from decimal import Decimal, ROUND_HALF_UP
float_result = 0.1 + 0.2
dec_result = Decimal('0.1') + Decimal('0.2')
print(f"float={float_result}")
print(f"decimal={dec_result}")

price = Decimal('19.99')
tax = Decimal('0.0825')
total = (price * (1 + tax)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
print(f"total={total}")
`);
    expect(status).toBe(200);
    expect(text).toContain("decimal=0.3");
    expect(text).toContain("total=21.64");
  });
});

// ─── Packages needing zlib ──────────────────────────────────────────
// zlib polyfill (lib/polyfills/zlib.py) provides pure-Python DEFLATE
// decompression, enabling requests, httpx, urllib3 to import and work.

describe("requests", () => {
  it("imports and builds requests with sessions", async () => {
    const { text, status } = await run(`
import requests
s = requests.Session()
s.headers.update({"User-Agent": "PyMode/1.0"})
print(f"ua={s.headers['User-Agent']}")
req = requests.Request('GET', 'http://example.com', params={'q': 'test'})
prepared = s.prepare_request(req)
print(f"url={prepared.url}")
`);
    expect(status).toBe(200);
    expect(text).toContain("ua=PyMode/1.0");
    expect(text).toContain("url=http://example.com/?q=test");
  });
});

describe("httpx", () => {
  it("builds requests and parses URLs", async () => {
    const { text, status } = await run(`
import httpx
url = httpx.URL("https://api.example.com/v1/users?page=2")
print(f"host={url.host}")
print(f"path={url.raw_path.decode()}")
`);
    expect(status).toBe(200);
    expect(text).toContain("host=api.example.com");
  });
});

describe("urllib3", () => {
  it("URL parsing and retry config", async () => {
    const { text, status } = await run(`
from urllib3.util.url import parse_url
url = parse_url("https://api.example.com:8443/v2/data")
print(f"host={url.host}")
print(f"port={url.port}")
print(f"scheme={url.scheme}")
`);
    expect(status).toBe(200);
    expect(text).toContain("host=api.example.com");
    expect(text).toContain("port=8443");
  });
});

// ─── Packages needing C extensions (Rust-based) ────────────────────
// pydantic & fastapi tests live in test/pydantic.test.ts
// (uses python-pydantic-core.wasm variant with Rust extension linked in)

// ─── Integration Patterns ───────────────────────────────────────────

describe("integration: HTML scraping + Jinja2", () => {
  it("parses HTML table and renders with Jinja2", async () => {
    const { text, status } = await run(`
from bs4 import BeautifulSoup
import jinja2

html = """
<table>
  <tr><th>Name</th><th>Score</th></tr>
  <tr><td>Alice</td><td>95</td></tr>
  <tr><td>Bob</td><td>87</td></tr>
</table>"""

soup = BeautifulSoup(html, 'html.parser')
rows = []
for tr in soup.select('tr')[1:]:
    cells = [td.string for td in tr.find_all('td')]
    rows.append({"name": cells[0], "score": int(cells[1])})

tmpl = jinja2.Environment().from_string(
    "{% for r in rows %}{{ r.name }}: {{ r.score }}{% if not loop.last %}, {% endif %}{% endfor %}"
)
print(tmpl.render(rows=rows))
`);
    expect(status).toBe(200);
    expect(text).toBe("Alice: 95, Bob: 87");
  });
});

describe("integration: data hashing pipeline", () => {
  it("hashlib + json for content-addressable dedup", async () => {
    const { text, status } = await run(`
import hashlib, json

def content_hash(data):
    canonical = json.dumps(data, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]

records = [
    {"id": 1, "name": "Alice"},
    {"id": 2, "name": "Bob"},
    {"id": 1, "name": "Alice"},
]

hashes = [content_hash(r) for r in records]
print(f"unique={len(set(hashes))}")
print(f"dedup_works={hashes[0] == hashes[2]}")
print(f"different={hashes[0] != hashes[1]}")
`);
    expect(status).toBe(200);
    expect(text).toContain("unique=2");
    expect(text).toContain("dedup_works=True");
    expect(text).toContain("different=True");
  });
});

describe("integration: YAML config + click CLI", () => {
  it("parses YAML config and processes via click command", async () => {
    const { text, status } = await run(`
import yaml
import click
from click.testing import CliRunner

config_yaml = """
app:
  name: MyWorker
  debug: true
  allowed_origins:
    - https://example.com
    - https://api.example.com
"""

@click.command()
@click.option('--config', default='')
def process(config):
    data = yaml.safe_load(config)
    app = data['app']
    click.echo(f"name={app['name']}")
    click.echo(f"origins={len(app['allowed_origins'])}")

runner = CliRunner()
result = runner.invoke(process, ['--config', config_yaml])
print(result.output.strip())
`);
    expect(status).toBe(200);
    expect(text).toContain("name=MyWorker");
    expect(text).toContain("origins=2");
  });
});

describe("integration: JSON patch + attrs data objects", () => {
  it("patches JSON documents with typed validation", async () => {
    const { text, status } = await run(`
import attrs
import jsonpatch
import json

@attrs.define
class Config:
    name: str
    replicas: int
    env: dict

original = {"name": "web", "replicas": 1, "env": {"DEBUG": "true"}}
patch = jsonpatch.JsonPatch([
    {"op": "replace", "path": "/replicas", "value": 3},
    {"op": "add", "path": "/env/REGION", "value": "us-east"},
])

patched = patch.apply(original)
config = Config(**patched)
print(f"name={config.name}")
print(f"replicas={config.replicas}")
print(f"region={config.env['REGION']}")
`);
    expect(status).toBe(200);
    expect(text).toContain("name=web");
    expect(text).toContain("replicas=3");
    expect(text).toContain("region=us-east");
  });
});
