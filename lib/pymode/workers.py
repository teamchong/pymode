"""PyMode Workers API — CF Python Workers compatible.

Provides Request, Response, and Env classes for writing Python Workers
with the same pattern as Cloudflare Python Workers:

    # src/entry.py
    from pymode.workers import Response

    async def on_fetch(request, env):
        return Response("Hello from PyMode!")

Request objects are constructed from the incoming HTTP request.
Response objects are serialized back to the Worker runtime.
Env provides access to CF bindings (KV, R2, D1, secrets).
"""

import json


class Headers:
    """Case-insensitive HTTP headers."""

    def __init__(self, data=None):
        self._headers = {}
        if isinstance(data, dict):
            for k, v in data.items():
                self._headers[k.lower()] = (k, v)
        elif isinstance(data, list):
            for k, v in data:
                self._headers[k.lower()] = (k, v)

    def get(self, name, default=None):
        entry = self._headers.get(name.lower())
        return entry[1] if entry else default

    def __getitem__(self, name):
        return self._headers[name.lower()][1]

    def __contains__(self, name):
        return name.lower() in self._headers

    def __iter__(self):
        return ((k, v) for k, v in self._headers.values())

    def items(self):
        return [(k, v) for k, v in self._headers.values()]

    def keys(self):
        return [k for k, _ in self._headers.values()]

    def values(self):
        return [v for _, v in self._headers.values()]

    def to_dict(self):
        return {k: v for k, v in self._headers.values()}


class Request:
    """Incoming HTTP request — matches CF Python Workers Request API."""

    def __init__(self, method="GET", url="", headers=None, body=None):
        self.method = method
        self.url = url
        self.headers = Headers(headers) if not isinstance(headers, Headers) else headers
        self._body = body or ""

    @property
    def path(self):
        from urllib.parse import urlparse
        return urlparse(self.url).path

    @property
    def query(self):
        from urllib.parse import urlparse, parse_qs
        return parse_qs(urlparse(self.url).query)

    def text(self):
        if isinstance(self._body, bytes):
            return self._body.decode("utf-8")
        return self._body

    def json(self):
        return json.loads(self.text())

    def bytes(self):
        if isinstance(self._body, str):
            return self._body.encode("utf-8")
        return self._body


class Response:
    """HTTP response — matches CF Python Workers Response API.

    Usage:
        Response("Hello")
        Response(json.dumps(data), headers={"Content-Type": "application/json"})
        Response("Not Found", status=404)
        Response.json({"key": "value"})
        Response.redirect("https://example.com")
    """

    def __init__(self, body="", status=200, headers=None):
        if isinstance(body, dict) or isinstance(body, list):
            self.body = json.dumps(body)
            self._headers = Headers(headers or {"Content-Type": "application/json"})
        elif isinstance(body, bytes):
            self.body = body
            self._headers = Headers(headers or {"Content-Type": "application/octet-stream"})
        else:
            self.body = str(body) if body is not None else ""
            self._headers = Headers(headers or {"Content-Type": "text/plain; charset=utf-8"})
        self.status = status

    @property
    def headers(self):
        return self._headers

    @classmethod
    def json(cls, data, status=200, headers=None):
        h = {"Content-Type": "application/json"}
        if headers:
            h.update(headers)
        return cls(json.dumps(data), status=status, headers=h)

    @classmethod
    def redirect(cls, url, status=302):
        return cls("", status=status, headers={"Location": url})

    def _serialize(self):
        """Serialize to JSON for the WASM boundary."""
        body = self.body
        is_binary = False
        if isinstance(body, bytes):
            import base64
            body = base64.b64encode(body).decode("ascii")
            is_binary = True
        return {
            "status": self.status,
            "headers": self._headers.to_dict(),
            "body": body,
            "bodyIsBinary": is_binary,
        }


class KVBinding:
    """KV namespace binding — matches CF Python Workers KV API.

    Usage:
        value = await env.MY_KV.get("key")
        await env.MY_KV.put("key", "value")
        await env.MY_KV.delete("key")
    """

    def get(self, key, type="text"):
        from pymode.env import KV
        data = KV.get(key)
        if data is None:
            return None
        if type == "text":
            return data.decode("utf-8")
        if type == "json":
            return json.loads(data.decode("utf-8"))
        return data  # arrayBuffer

    def put(self, key, value):
        from pymode.env import KV
        if isinstance(value, str):
            value = value.encode("utf-8")
        KV.put(key, value)

    def delete(self, key):
        from pymode.env import KV
        KV.delete(key)


class R2Binding:
    """R2 bucket binding."""

    def get(self, key):
        from pymode.env import R2
        return R2.get(key)

    def put(self, key, value):
        from pymode.env import R2
        if isinstance(value, str):
            value = value.encode("utf-8")
        R2.put(key, value)


class D1Binding:
    """D1 database binding."""

    def prepare(self, sql):
        return D1Statement(sql)


class D1Statement:
    """D1 prepared statement."""

    def __init__(self, sql):
        self._sql = sql
        self._params = []

    def bind(self, *params):
        self._params = list(params)
        return self

    def all(self):
        from pymode.env import D1
        return {"results": D1.execute(self._sql, self._params)}

    def first(self, column=None):
        result = self.all()
        rows = result.get("results", [])
        if not rows:
            return None
        if column:
            return rows[0].get(column)
        return rows[0]

    def run(self):
        from pymode.env import D1
        D1.execute(self._sql, self._params)


# Binding type hints recognized by Env
_BINDING_TYPES = {
    "KV": KVBinding,
    "R2": R2Binding,
    "D1": D1Binding,
}


class Env:
    """Access CF bindings and environment variables.

    Attribute access returns binding objects or secret values:
        env.MY_KV   -> KVBinding (with .get/.put/.delete)
        env.MY_R2   -> R2Binding
        env.MY_D1   -> D1Binding (with .prepare)
        env.SECRET  -> string value

    Binding names ending in _KV, _R2, _D1 (or matching common patterns)
    automatically return the right binding wrapper. Other names return
    string values from env vars.
    """

    def __init__(self, bindings=None):
        self._bindings = bindings or {}
        self._binding_cache = {}

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        # Check cache
        if name in self._binding_cache:
            return self._binding_cache[name]

        # Check if this is a known binding type
        binding = self._detect_binding(name)
        if binding is not None:
            self._binding_cache[name] = binding
            return binding

        # Try string value from env data
        val = self._bindings.get(name)
        if val is not None:
            return val

        # Try host import for env vars
        try:
            import _pymode
            result = _pymode.env_get(name)
            if result is not None:
                return result
        except ImportError:
            pass

        raise AttributeError(f"No binding or env var: {name}")

    def _detect_binding(self, name):
        """Auto-detect binding type from name patterns."""
        upper = name.upper()
        if upper.endswith("_KV") or upper == "KV":
            return KVBinding()
        if upper.endswith("_R2") or upper == "R2":
            return R2Binding()
        if upper.endswith("_D1") or upper == "D1" or upper.endswith("_DB"):
            return D1Binding()
        return None
