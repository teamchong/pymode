"""PyMode request handler — runtime entry point.

This module is NOT imported by user code. It's the entry point that the
WASM runtime calls for each request. It:

1. Reads the serialized request from stdin (JSON)
2. Imports the user's entry module
3. Calls on_fetch(request, env) or fetch(request, env)
4. Serializes the Response to stdout (JSON)

The Worker (JS) reads stdout JSON and constructs the CF Response.
"""

import sys
import json
import importlib
import traceback

from pymode.workers import Request, Response, Headers, Env


def _run():
    # Entry module path from argv: python _handler.py <module_path>
    if len(sys.argv) < 2:
        _error_response(500, "No entry module specified")
        return

    module_name = sys.argv[1]

    # Read request JSON from stdin
    try:
        request_json = sys.stdin.read()
        request_data = json.loads(request_json) if request_json.strip() else {}
    except Exception as e:
        _error_response(500, f"Failed to parse request: {e}")
        return

    # Build Request object
    req_data = request_data.get("request", {})
    request = Request(
        method=req_data.get("method", "GET"),
        url=req_data.get("url", ""),
        headers=req_data.get("headers", {}),
        body=req_data.get("body", ""),
    )

    # Build Env object
    env_data = request_data.get("env", {})
    env = Env(env_data)

    # Import user module
    try:
        mod = importlib.import_module(module_name)
    except ImportError as e:
        _error_response(500, f"Cannot import entry module '{module_name}': {e}")
        return
    except Exception as e:
        _error_response(500, f"Error loading '{module_name}': {traceback.format_exc()}")
        return

    # Find handler
    handler = getattr(mod, "on_fetch", None) or getattr(mod, "fetch", None)
    if handler is None:
        _error_response(500,
            f"No on_fetch() or fetch() handler in '{module_name}'. "
            f"Define: async def on_fetch(request, env): ...")
        return

    # Call handler
    try:
        result = handler(request, env)

        # Handle async handlers (coroutines)
        # In WASM CPython, we don't have a real event loop, so we drive
        # the coroutine manually for simple await patterns
        if hasattr(result, "send"):
            try:
                result.send(None)
            except StopIteration as stop:
                result = stop.value
            except Exception:
                raise

        # Normalize result to Response
        if isinstance(result, Response):
            response = result
        elif isinstance(result, str):
            response = Response(result)
        elif isinstance(result, dict):
            response = Response.json(result)
        elif isinstance(result, bytes):
            response = Response(result)
        else:
            response = Response(str(result) if result is not None else "")

    except Exception as e:
        _error_response(500, f"Handler error: {traceback.format_exc()}")
        return

    # Serialize response to stdout
    _write_response(response)


def _write_response(response):
    """Write serialized response JSON to stdout."""
    output = response._serialize()
    sys.stdout.write(json.dumps(output))
    sys.stdout.flush()


def _error_response(status, message):
    """Write an error response to stdout."""
    resp = Response(message, status=status)
    _write_response(resp)


if __name__ == "__main__":
    _run()
