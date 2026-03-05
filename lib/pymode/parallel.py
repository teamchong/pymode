"""PyMode parallel execution — real parallelism via child Durable Objects.

Each spawned task runs in a separate DO with its own:
  - 30s CPU budget
  - 128MB memory
  - python.wasm instance
  - Full access to host imports (TCP, HTTP, KV, R2, D1)

Arguments and results are serialized via pickle. No shared mutable state
between tasks — each runs in its own WASM linear memory.

Usage:
    from pymode.parallel import spawn, map_parallel, gather

    # Spawn a single task
    handle = spawn(my_function, arg1, arg2)
    result = handle.join()

    # Map over a list in parallel (up to 32 concurrent)
    results = map_parallel(process_item, items)

    # Gather multiple independent tasks
    results = gather(
        (fetch_users, [page]),
        (compute_stats, [data]),
        (send_email, [msg]),
    )
"""

import pickle

_pymode = None
try:
    import _pymode as _pymode_mod
    _pymode = _pymode_mod
except ImportError:
    pass


def _require_host_imports():
    if _pymode is None:
        raise RuntimeError(
            "pymode.parallel requires PythonDO host imports. "
            "Run inside PythonDO, not the legacy Worker."
        )


class TaskHandle:
    """Handle to a spawned parallel task running in a child DO."""

    def __init__(self, thread_id):
        self._thread_id = thread_id
        self._result = None
        self._joined = False

    def join(self):
        """Block until the task completes and return its result.

        The result is deserialized (unpickled) from the child DO's output.
        Raises RuntimeError if the child raised an exception.
        """
        if self._joined:
            return self._result

        _require_host_imports()
        raw = _pymode.thread_join(self._thread_id)
        data = pickle.loads(raw)

        self._joined = True
        if data.get("error"):
            raise RuntimeError(f"Task failed: {data['error']}")
        self._result = data["result"]
        return self._result


def spawn(fn, *args, **kwargs):
    """Spawn a function in a child DO. Returns a TaskHandle.

    The function, args, and kwargs are pickled and sent to the child.
    The child unpickles, calls fn(*args, **kwargs), pickles the result.

    Args:
        fn: A picklable callable (module-level function, not lambda/closure)
        *args: Positional arguments (must be picklable)
        **kwargs: Keyword arguments (must be picklable)

    Returns:
        TaskHandle that can be joined to get the result
    """
    _require_host_imports()

    # Serialize the callable and arguments
    input_data = pickle.dumps({"fn": fn, "args": args, "kwargs": kwargs})

    # The child DO will execute this code, which unpickles and calls the function
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

    thread_id = _pymode.thread_spawn(child_code, input_data)
    return TaskHandle(thread_id)


def map_parallel(fn, items, max_concurrent=32):
    """Map a function over items in parallel using child DOs.

    Each item is processed in a separate DO. Up to max_concurrent tasks
    run simultaneously (CF limit: 32 fan-out per request chain).

    Args:
        fn: A picklable callable
        items: Iterable of arguments (each item passed as sole arg to fn)
        max_concurrent: Max parallel tasks (default 32, CF limit)

    Returns:
        List of results in the same order as items
    """
    items = list(items)
    if not items:
        return []

    results = [None] * len(items)

    # Process in batches of max_concurrent
    for batch_start in range(0, len(items), max_concurrent):
        batch_end = min(batch_start + max_concurrent, len(items))
        batch_items = items[batch_start:batch_end]

        # Spawn all tasks in this batch
        handles = [spawn(fn, item) for item in batch_items]

        # Join all tasks
        for i, handle in enumerate(handles):
            results[batch_start + i] = handle.join()

    return results


def gather(*tasks):
    """Run multiple independent tasks in parallel and gather results.

    Each task is a tuple of (fn, args) or (fn, args, kwargs).

    Args:
        *tasks: Each is (callable, args_list) or (callable, args_list, kwargs_dict)

    Returns:
        List of results in the same order as tasks

    Example:
        results = gather(
            (fetch_data, ["url1"]),
            (fetch_data, ["url2"]),
            (compute, [42], {"verbose": True}),
        )
    """
    handles = []
    for task in tasks:
        if len(task) == 2:
            fn, args = task
            kwargs = {}
        elif len(task) == 3:
            fn, args, kwargs = task
        else:
            raise ValueError("Each task must be (fn, args) or (fn, args, kwargs)")
        handles.append(spawn(fn, *args, **kwargs))

    return [h.join() for h in handles]
