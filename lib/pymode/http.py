"""PyMode HTTP bridge — enables sync HTTP from WASM via re-execution trampoline.

On first encounter of a fetch request, queues it to VFS and exits with code 254.
The JS host catches exit 254, executes all pending fetches via Promise.all,
writes responses to VFS, and re-runs Python. On the re-run, this module finds
the pre-fetched response in VFS and returns it directly.

Usage:
    import pymode.http
    pymode.http.install()  # patches urllib.request
"""

import os
import json
import sys
import base64


PENDING_PATH = "/stdlib/tmp/_pymode_pending_fetches.json"
RESPONSE_DIR = "/stdlib/tmp/_pymode_fetch_responses"


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
    """Perform an HTTP fetch via the re-execution trampoline.

    If a cached response exists in VFS, returns it immediately.
    Otherwise, queues the request and exits with code 254.
    """
    # Check all response files — key is the request index from the pending array
    # Scan for a matching response by looking at each index's stored URL
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

    # First encounter — queue this fetch request
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
