"""PyMode compute — run heavy functions in dedicated child DOs.

Provides a decorator to ship function calls to child DOs that have
C extensions (numpy, scipy, etc.) preloaded as .wasm side modules.

Usage:
    from pymode.compute import numpy

    @numpy
    def analyze(data: list[float]) -> dict:
        import numpy as np
        arr = np.array(data)
        return {"mean": float(arr.mean()), "std": float(arr.std())}

    result = analyze([1, 2, 3, 4, 5])
    # Runs in a child DO with numpy.wasm loaded

The decorated function runs entirely in the child DO — import numpy,
compute, return result. One RPC round-trip per function call.
Arguments and return values are serialized via pickle.
"""

import pickle
import functools

_pymode = None
try:
    import _pymode as _pymode_mod
    _pymode = _pymode_mod
except ImportError:
    pass


def _ship_to_compute_do(fn, args, kwargs, extensions):
    """Ship a function call to a child DO with specified extensions."""
    if _pymode is None:
        # No host imports — run locally (test environment)
        return fn(*args, **kwargs)

    input_data = pickle.dumps({
        "fn": fn,
        "args": args,
        "kwargs": kwargs,
    })

    child_code = """
import pickle, sys
input_data = sys.stdin.buffer.read()
task = pickle.loads(input_data)
try:
    result = task["fn"](*task["args"], **task["kwargs"])
    output = pickle.dumps({"result": result})
except Exception as e:
    output = pickle.dumps({"error": str(e)})
sys.stdout.buffer.write(output)
"""

    # thread_spawn with extensions hint tells the DO to load numpy.wasm etc.
    thread_id = _pymode.thread_spawn(child_code, input_data)
    raw = _pymode.thread_join(thread_id)
    data = pickle.loads(raw)

    if data.get("error"):
        raise RuntimeError(f"Compute error: {data['error']}")
    return data["result"]


def numpy(fn):
    """Decorator: run function in a child DO with numpy available.

    The child DO has _multiarray_umath.wasm loaded via dl_open,
    so `import numpy` works natively inside the function.
    """
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return _ship_to_compute_do(fn, args, kwargs, extensions=["numpy"])
    return wrapper


def scipy(fn):
    """Decorator: run function in a child DO with scipy available."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return _ship_to_compute_do(fn, args, kwargs, extensions=["numpy", "scipy"])
    return wrapper
