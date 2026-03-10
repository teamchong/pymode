"""Test handler — executes Python code sent via POST through the full DO pipeline.

Request flow:
  HTTP POST code → Worker → PythonDO.handleRequest() (RPC) → Asyncify → python.wasm
  → _handler.py → this module's on_fetch() → exec(code) → Response(stdout)
"""

import sys
import io
import traceback
from pymode.workers import Request, Response, Env


def on_fetch(request, env):
    code = request.text()
    if not code:
        return Response("ready")

    # Make env available to exec'd code so binding tests work
    globals_dict = {"env": env, "__builtins__": __builtins__}

    old_stdout = sys.stdout
    sys.stdout = buf = io.StringIO()
    try:
        exec(compile(code, "<test>", "exec"), globals_dict)
        output = buf.getvalue()
        return Response(output, status=200)
    except Exception:
        output = buf.getvalue() + traceback.format_exc()
        return Response(output, status=500)
    finally:
        sys.stdout = old_stdout
