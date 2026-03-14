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
import os
import json
import importlib
import traceback

from pymode.workers import Request, Response, Headers, Env

# Zerobuf exchange layout constants (must match host-imports.ts)
_ZB_REQUEST_BASE = 0
_ZB_RESPONSE_BASE = 64
_ZB_RESP_POOL_START = 32768
_ZB_VALUE_SLOT = 16
_ZB_STRING_HEADER = 4
_ZB_TAG_I32 = 2
_ZB_TAG_STRING = 4
_ZB_TAG_BOOL = 1


def _run():
    # Entry module path from argv: python _handler.py <module_path>
    if len(sys.argv) < 2:
        _error_response(500, "No entry module specified")
        return

    module_name = sys.argv[1]

    # Add the entry module's parent directory to sys.path so sibling imports work.
    parts = module_name.rsplit(".", 1)
    if len(parts) == 2:
        parent_dir = os.path.join(os.getcwd(), parts[0].replace(".", os.sep))
        if os.path.isdir(parent_dir) and parent_dir not in sys.path:
            sys.path.insert(0, parent_dir)

    # Check for zerobuf exchange mode — zero-copy via shared WASM memory
    exchange_ptr = _get_zerobuf_exchange_ptr()
    if exchange_ptr > 0:
        _run_zerobuf(module_name, exchange_ptr)
        return

    # Fallback: JSON stdin/stdout mode
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

    # Check for workflow
    from pymode.workflows import Workflow
    wf = getattr(mod, "workflow", None)
    if wf is not None and isinstance(wf, Workflow) and request.path.startswith("/workflow/"):
        try:
            response = _handle_workflow(wf, request, env)
        except Exception as e:
            _error_response(500, f"Workflow error: {_format_user_traceback(e)}")
            return
        _write_response(response)
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

        # Handle async handlers (coroutines).
        # In WASM CPython we don't have a real event loop, so we drive
        # the coroutine manually. Only single-await coroutines are supported.
        if hasattr(result, "send"):
            try:
                result.send(None)
            except StopIteration as stop:
                result = stop.value

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
        _error_response(500, f"Handler error: {_format_user_traceback(e)}")
        return

    # Serialize response to stdout
    _write_response(response)


def _handle_workflow(wf, request, env):
    """Dispatch workflow requests."""
    path = request.path

    if path == "/workflow/run" and request.method == "POST":
        body = request.json()
        workflow_id = body.get("workflow_id", f"{wf.name}_{int(__import__('time').time())}")
        input_data = body.get("input", {})
        result = wf.run(workflow_id, input_data, env)
        return Response.json(result.to_dict())

    if path == "/workflow/resume" and request.method == "POST":
        body = request.json()
        workflow_id = body.get("workflow_id")
        if not workflow_id:
            return Response.json({"error": "workflow_id required"}, status=400)
        journal = body.get("journal")
        input_data = body.get("input", {})
        result = wf.run(workflow_id, input_data, env, journal=journal)
        return Response.json(result.to_dict())

    if path == "/workflow/info":
        steps = [{"name": s.name, "retries": s.retries, "backoff": s.backoff}
                 for s in wf.steps]
        return Response.json({"name": wf.name, "steps": steps})

    return Response.json({"error": "Unknown workflow endpoint. Use /workflow/run, /workflow/resume, or /workflow/info"}, status=404)


def _format_user_traceback(exc):
    """Format traceback with only user code frames (filter out pymode internals)."""
    tb_lines = traceback.format_exception(type(exc), exc, exc.__traceback__)
    filtered = []
    for line in tb_lines:
        # Skip frames from pymode internals
        if "pymode/_handler.py" in line or "pymode\\_handler.py" in line:
            continue
        filtered.append(line)
    return "".join(filtered) if filtered else traceback.format_exc()


def _write_response(response):
    """Write serialized response JSON to stdout."""
    output = response._serialize()
    sys.stdout.write(json.dumps(output))
    sys.stdout.flush()


def _error_response(status, message):
    """Write an error response to stdout."""
    resp = Response(message, status=status)
    _write_response(resp)


def _get_zerobuf_exchange_ptr():
    """Get the zerobuf exchange pointer from the host. Returns 0 if not available."""
    try:
        import _pymode
        return _pymode.zerobuf_exchange_ptr()
    except (ImportError, AttributeError):
        return 0


def _run_zerobuf(module_name, exchange_ptr):
    """Handle request via zerobuf — zero-copy through WASM linear memory."""
    import _zerobuf

    # Read request fields from WASM memory (zero-copy — no JSON parsing)
    req_base = exchange_ptr + _ZB_REQUEST_BASE
    method = _zerobuf.schema_read_field(req_base, 0) or "GET"
    url = _zerobuf.schema_read_field(req_base, 1) or ""
    headers_json = _zerobuf.schema_read_field(req_base, 2) or "{}"
    body = _zerobuf.schema_read_field(req_base, 3) or ""

    headers = json.loads(headers_json) if headers_json != "{}" else {}

    request = Request(method=method, url=url, headers=headers, body=body)
    env = Env({})

    # Import user module
    try:
        mod = importlib.import_module(module_name)
    except Exception as e:
        _write_zerobuf_response(exchange_ptr, 500, f"Cannot import '{module_name}': {e}")
        return

    # Find handler
    handler = getattr(mod, "on_fetch", None) or getattr(mod, "fetch", None)
    if handler is None:
        _write_zerobuf_response(exchange_ptr, 500, f"No on_fetch() handler in '{module_name}'")
        return

    # Call handler
    try:
        result = handler(request, env)
        if hasattr(result, "send"):
            try:
                result.send(None)
            except StopIteration as stop:
                result = stop.value

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
        _write_zerobuf_response(exchange_ptr, 500, f"Handler error: {_format_user_traceback(e)}")
        return

    # Write response to zerobuf exchange region (zero-copy — no JSON serialization)
    resp_data = response._serialize()
    resp_body = resp_data.get("body", "")
    resp_headers = json.dumps(resp_data.get("headers", {}))
    resp_status = resp_data.get("status", 200)
    body_is_binary = resp_data.get("bodyIsBinary", False)

    _write_zerobuf_response(exchange_ptr, resp_status, resp_body, resp_headers, body_is_binary)


def _write_zerobuf_response(exchange_ptr, status, body="", headers_json="{}", body_is_binary=False):
    """Write response fields into the zerobuf exchange region via _zerobuf native module."""
    import _zerobuf

    resp_base = exchange_ptr + _ZB_RESPONSE_BASE
    pool_base = exchange_ptr + _ZB_RESP_POOL_START

    # Field 0: status (i32)
    _zerobuf.write_i32(resp_base + 0 * _ZB_VALUE_SLOT, status)

    # Field 1: body (string) — write string header+data in the response pool
    pool_offset = 0
    body_str = body if isinstance(body, str) else body.decode("utf-8", errors="replace")
    body_header_ptr = pool_base + pool_offset
    written = _zerobuf.write_string_at(body_header_ptr, body_str)
    pool_offset += written
    _zerobuf.write_string_slot(resp_base + 1 * _ZB_VALUE_SLOT, body_header_ptr)

    # Field 2: headers_json (string)
    headers_header_ptr = pool_base + pool_offset
    written = _zerobuf.write_string_at(headers_header_ptr, headers_json)
    pool_offset += written
    _zerobuf.write_string_slot(resp_base + 2 * _ZB_VALUE_SLOT, headers_header_ptr)

    # Field 3: body_is_binary (bool)
    _zerobuf.write_bool(resp_base + 3 * _ZB_VALUE_SLOT, body_is_binary)


if __name__ == "__main__":
    _run()
