"""ThreadPoolExecutor polyfill for single-threaded WASM.

Runs submitted tasks synchronously and immediately. Results are available
as soon as submit() returns. This gives hermes-agent's delegate_tool and
model_tools the ThreadPoolExecutor interface they expect without deadlocking
on queue.get() in WASM's single-threaded runtime.
"""

from concurrent.futures._base import (
    Future,
    Executor,
    as_completed,
    wait,
    FIRST_COMPLETED,
    FIRST_EXCEPTION,
    ALL_COMPLETED,
    CancelledError,
    TimeoutError,
    BrokenExecutor,
)

__all__ = ["ThreadPoolExecutor", "BrokenThreadPool"]


class BrokenThreadPool(BrokenExecutor):
    pass


class ThreadPoolExecutor(Executor):
    """Synchronous executor for single-threaded WASM.

    Tasks run immediately in submit() — no threads, no queues.
    max_workers is accepted but ignored.
    """

    def __init__(self, max_workers=None, thread_name_prefix="",
                 initializer=None, initargs=()):
        self._shutdown = False
        self._initializer = initializer
        self._initargs = initargs
        self._initialized = False

    def _ensure_initialized(self):
        if not self._initialized and self._initializer:
            self._initializer(*self._initargs)
            self._initialized = True

    def submit(self, fn, /, *args, **kwargs):
        if self._shutdown:
            raise RuntimeError("cannot schedule new futures after shutdown")

        self._ensure_initialized()

        future = Future()
        try:
            result = fn(*args, **kwargs)
            future.set_result(result)
        except BaseException as e:
            future.set_exception(e)

        return future

    def map(self, fn, *iterables, timeout=None, chunksize=1):
        results = []
        for args in zip(*iterables):
            f = self.submit(fn, *args)
            results.append(f.result())
        return iter(results)

    def shutdown(self, wait=True, *, cancel_futures=False):
        self._shutdown = True

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.shutdown()
