"""Test handler — executes Python code sent via POST through the full DO pipeline.

Request flow:
  HTTP POST code → Worker → PythonDO.handleRequest() (RPC) → Asyncify → python.wasm
  → _handler.py → this module's on_fetch() → exec(code) → Response(stdout)
"""

import _wasi_compat  # noqa: F401 — polyfills os.getpid etc.
import sys
import io
import traceback
from pymode.workers import Request, Response, Env


def on_fetch(request, env):
    code = request.text()
    if not code:
        return Response("ready")

    # Use __main__.__dict__ as globals so pickle can find functions
    # defined in exec'd code (pickle does attribute lookup on __main__)
    import __main__
    __main__.__dict__["env"] = env

    old_stdout = sys.stdout
    sys.stdout = buf = io.StringIO()
    try:
        exec(compile(code, "<test>", "exec"), __main__.__dict__)
        output = buf.getvalue()
        return Response(output, status=200)
    except Exception:
        output = buf.getvalue() + traceback.format_exc()
        return Response(output, status=500)
    finally:
        sys.stdout = old_stdout
