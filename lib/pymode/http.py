"""PyMode HTTP bridge — host imports for direct HTTP via PythonDO.

When running inside PythonDO, HTTP calls go through WASM host imports
(the _pymode C extension module). The JS host performs the fetch and
buffers the response for Python to read back synchronously.

When _pymode is not available (legacy VFS trampoline mode), falls back
to the original ops-log approach with sys.exit(254).

Usage:
    import pymode.http
    pymode.http.install()  # patches urllib.request

    # Direct usage:
    resp = pymode.http.fetch("https://example.com")
    print(resp.status, resp.read())

    # Or via get/post helpers:
    resp = pymode.http.get("https://api.example.com/data")
"""

import json

_pymode = None
try:
    import _pymode as _pymode_mod
    _pymode = _pymode_mod
except ImportError:
    pass


def _use_host_imports():
    return _pymode is not None


class HTTPResponse:
    """Minimal response object compatible with urllib.request return values."""

    def __init__(self, status, headers, body):
        self.status = status
        self.code = status
        self.headers = headers
        self.reason = ""
        self._body = body

    def read(self, amt=-1):
        if amt < 0:
            data = self._body
            self._body = b""
            return data
        data = self._body[:amt]
        self._body = self._body[amt:]
        return data

    def getheader(self, name, default=None):
        return self.headers.get(name.lower(), default)

    def getheaders(self):
        return list(self.headers.items())

    def info(self):
        return self

    def get_all(self, name, default=None):
        v = self.headers.get(name.lower())
        if v is not None:
            return [v]
        return default or []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def fetch(url, method="GET", headers=None, body=None):
    """Perform an HTTP fetch via host imports or the VFS trampoline."""
    if _use_host_imports():
        return _fetch_host_imports(url, method, headers, body)
    else:
        return _fetch_legacy(url, method, headers, body)


def _fetch_host_imports(url, method, headers, body):
    """Fetch via _pymode host imports — runs inside PythonDO."""
    body_bytes = b""
    if body is not None:
        body_bytes = body if isinstance(body, bytes) else body.encode()

    headers_json = json.dumps(dict(headers or {}))
    resp_id = _pymode.http_fetch(url, method or "GET", body_bytes, headers_json)

    status = _pymode.http_response_status(resp_id)

    # Read the full response body
    chunks = []
    while True:
        chunk = _pymode.http_response_read(resp_id, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    resp_body = b"".join(chunks)

    # Read common headers
    resp_headers = {}
    for hdr in ["content-type", "content-length", "location", "set-cookie",
                 "cache-control", "etag", "last-modified"]:
        val = _pymode.http_response_header(resp_id, hdr)
        if val is not None:
            resp_headers[hdr] = val

    return HTTPResponse(status=status, headers=resp_headers, body=resp_body)


def _fetch_legacy(url, method, headers, body):
    """Fetch via the VFS re-execution trampoline (legacy Worker mode)."""
    import os
    import sys
    import base64

    PENDING_PATH = "/stdlib/tmp/_pymode_pending_fetches.json"
    RESPONSE_DIR = "/stdlib/tmp/_pymode_fetch_responses"

    idx = 0
    while True:
        resp_path = f"{RESPONSE_DIR}/{idx}"
        if not os.path.exists(resp_path):
            break
        with open(resp_path, "rb") as f:
            data = json.load(f)
        if data.get("url") == url and data.get("method", "GET") == method:
            body_bytes = base64.b64decode(data["bodyBase64"])
            return HTTPResponse(
                status=data["status"],
                headers={k.lower(): v for k, v in data.get("headers", {}).items()},
                body=body_bytes,
            )
        idx += 1

    pending = []
    if os.path.exists(PENDING_PATH):
        with open(PENDING_PATH) as f:
            pending = json.load(f)

    req_body = None
    if body is not None:
        if isinstance(body, bytes):
            req_body = base64.b64encode(body).decode("ascii")
        else:
            req_body = body

    pending.append({
        "method": method,
        "url": url,
        "headers": dict(headers or {}),
        "body": req_body,
        "bodyIsBase64": isinstance(body, bytes),
    })

    pending_dir = os.path.dirname(PENDING_PATH)
    if not os.path.exists(pending_dir):
        os.makedirs(pending_dir, exist_ok=True)
    with open(PENDING_PATH, "w") as f:
        json.dump(pending, f)

    sys.exit(254)


class _TrampolineHTTPHandler:
    """urllib.request handler that routes all HTTP/HTTPS through the trampoline."""

    def http_open(self, req):
        return self._open(req)

    def https_open(self, req):
        return self._open(req)

    def _open(self, req):
        url = req.full_url
        method = req.get_method()
        headers = dict(req.header_items())
        body = req.data
        return fetch(url, method=method, headers=headers, body=body)


def get(url, headers=None):
    """HTTP GET request."""
    return fetch(url, method="GET", headers=headers)


def post(url, body=None, headers=None):
    """HTTP POST request."""
    return fetch(url, method="POST", headers=headers, body=body)


_installed = False


def install():
    """Patch urllib.request.urlopen to use the trampoline.

    Safe to call multiple times; only patches once.
    Requires urllib.request to be importable (needs http.client etc in stdlib).
    """
    global _installed
    if _installed:
        return
    _installed = True

    import urllib.request

    def _trampoline_urlopen(url, data=None, timeout=None, **kwargs):
        if isinstance(url, str):
            method = "POST" if data is not None else "GET"
            headers = {}
            req_body = data
        else:
            method = url.get_method()
            headers = dict(url.header_items())
            req_body = url.data
            url = url.full_url

        return fetch(url, method=method, headers=headers, body=req_body)

    urllib.request.urlopen = _trampoline_urlopen
