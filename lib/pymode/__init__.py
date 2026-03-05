# PyMode runtime support for Cloudflare Workers
#
# Modules:
#   pymode.tcp  - TCP socket replacement (DB drivers, etc.)
#   pymode.http - HTTP fetch (urllib replacement)
#   pymode.env  - CF bindings (KV, R2, D1) and environment variables
#
# When running inside PythonDO, these use WASM host imports for direct access.
# When running in legacy Worker mode, they use the VFS re-execution trampoline.
