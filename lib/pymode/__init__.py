# PyMode runtime support for Cloudflare Workers
#
# Modules:
#   pymode.workers  - Request, Response, Env (CF Python Workers compatible API)
#   pymode.tcp      - TCP socket replacement (DB drivers, etc.)
#   pymode.http     - HTTP fetch (urllib replacement)
#   pymode.env      - CF bindings (KV, R2, D1) and environment variables
#   pymode.parallel - Threading via child DOs
#
# Usage (entry.py):
#   from pymode.workers import Response
#
#   def on_fetch(request, env):
#       return Response("Hello from PyMode!")
#
# When running inside PythonDO, these use WASM host imports for direct access.
# When running in legacy Worker mode, they use the VFS re-execution trampoline.
