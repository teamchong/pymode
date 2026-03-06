"""WASI compatibility patches for Cloudflare Workers.

Patches missing os/process functions that WASI doesn't provide but
third-party packages (requests, tempfile, multiprocessing) expect.

Imported as the first line before user code by the Worker runtime.
"""

import os

# WASI has no process model — provide defaults for packages that check these.
if not hasattr(os, "getpid"):
    os.getpid = lambda: 1

if not hasattr(os, "getuid"):
    os.getuid = lambda: 0

if not hasattr(os, "getgid"):
    os.getgid = lambda: 0

if not hasattr(os, "getppid"):
    os.getppid = lambda: 0

if not hasattr(os, "kill"):
    def _kill(pid, sig):
        raise OSError("kill not available in WASI")
    os.kill = _kill

if not hasattr(os, "getlogin"):
    os.getlogin = lambda: "worker"

if not hasattr(os, "uname"):
    class _Uname:
        sysname = "WASI"
        nodename = "cloudflare"
        release = "0.0.0"
        version = "0.0.0"
        machine = "wasm32"
    os.uname = lambda: _Uname()

# Pre-set tempdir to /tmp (exists in MemFS) to avoid tempfile's
# directory probe which requires writing test files.
import tempfile as _tempfile
_tempfile.tempdir = "/tmp"
del _tempfile
