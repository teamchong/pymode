"""Threading module shim for PyMode WASM runtime.

Provides the subset of the threading API that packages check at import
time. Single-threaded WASM has no real threads, but many packages only
need Lock (as a no-op), current_thread(), and Event for initialization.

For real parallelism, use pymode.parallel which spawns child DOs.

Packages this unblocks: logging, concurrent.futures, queue, unittest,
http.client, urllib3, requests, and many more.
"""

import time as _time


class _DummyLock:
    """No-op lock for single-threaded WASM."""

    _locked = False

    def acquire(self, blocking=True, timeout=-1):
        self._locked = True
        return True

    def release(self):
        self._locked = False

    def locked(self):
        return self._locked

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *args):
        self.release()


class _DummyRLock(_DummyLock):
    """No-op reentrant lock."""

    _count = 0

    def acquire(self, blocking=True, timeout=-1):
        self._count += 1
        self._locked = True
        return True

    def release(self):
        self._count -= 1
        if self._count <= 0:
            self._count = 0
            self._locked = False


class _DummyCondition:
    """No-op condition variable."""

    def __init__(self, lock=None):
        self._lock = lock or _DummyRLock()

    def acquire(self, *args, **kwargs):
        return self._lock.acquire(*args, **kwargs)

    def release(self):
        self._lock.release()

    def wait(self, timeout=None):
        if timeout:
            _time.sleep(timeout)
        return True

    def wait_for(self, predicate, timeout=None):
        return predicate()

    def notify(self, n=1):
        pass

    def notify_all(self):
        pass

    notifyAll = notify_all

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *args):
        self.release()


class Event:
    """Single-threaded event — set/wait are immediate."""

    def __init__(self):
        self._flag = False

    def is_set(self):
        return self._flag

    isSet = is_set

    def set(self):
        self._flag = True

    def clear(self):
        self._flag = False

    def wait(self, timeout=None):
        return self._flag


class Semaphore:
    """Single-threaded semaphore."""

    def __init__(self, value=1):
        self._value = value

    def acquire(self, blocking=True, timeout=None):
        if self._value > 0:
            self._value -= 1
            return True
        return False

    def release(self):
        self._value += 1

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *args):
        self.release()


class BoundedSemaphore(Semaphore):
    def __init__(self, value=1):
        self._initial = value
        super().__init__(value)

    def release(self):
        if self._value >= self._initial:
            raise ValueError("Semaphore released too many times")
        super().release()


class _DummyThread:
    """Represents the single main thread."""

    def __init__(self):
        self._name = "MainThread"
        self._ident = 1
        self._daemon = False
        self._is_alive = True

    @property
    def name(self):
        return self._name

    @name.setter
    def name(self, value):
        self._name = value

    @property
    def ident(self):
        return self._ident

    @property
    def native_id(self):
        return 1

    @property
    def daemon(self):
        return self._daemon

    @daemon.setter
    def daemon(self, value):
        self._daemon = value

    def is_alive(self):
        return self._is_alive

    isAlive = is_alive

    def getName(self):
        return self._name

    def setName(self, name):
        self._name = name

    def isDaemon(self):
        return self._daemon

    def setDaemon(self, daemonic):
        self._daemon = daemonic


_main_thread = _DummyThread()


class Thread:
    """Thread that runs target in a child Durable Object via pymode.parallel.

    When host imports are available (running in PythonDO), Thread.start()
    spawns the target function in a separate DO with its own 30s CPU and
    128MB memory. Thread.join() blocks until the child completes.

    When host imports are unavailable (test environment), falls back to
    running the target synchronously in the current thread.
    """

    _next_ident = 2  # 1 is MainThread

    def __init__(self, group=None, target=None, name=None, args=(), kwargs=None, daemon=None):
        self._target = target
        self._name = name or "Thread"
        self._args = args
        self._kwargs = kwargs or {}
        self._daemon = daemon or False
        self._started = False
        self._alive = False
        self._ident = None
        self._handle = None  # pymode.parallel.TaskHandle
        self._result = None
        self._error = None

    @property
    def name(self):
        return self._name

    @name.setter
    def name(self, value):
        self._name = value

    @property
    def ident(self):
        return self._ident

    @property
    def daemon(self):
        return self._daemon

    @daemon.setter
    def daemon(self, value):
        self._daemon = value

    def is_alive(self):
        return self._alive

    isAlive = is_alive

    def start(self):
        if self._started:
            raise RuntimeError("threads can only be started once")
        self._started = True
        self._alive = True
        self._ident = Thread._next_ident
        Thread._next_ident += 1

        if self._target is None:
            self._alive = False
            return

        try:
            from pymode.parallel import spawn
            # Run in a child DO — real parallelism
            self._handle = spawn(self._target, *self._args, **self._kwargs)
        except (ImportError, RuntimeError):
            # No host imports available — run synchronously
            try:
                self._result = self._target(*self._args, **self._kwargs)
            except Exception as e:
                self._error = e
            self._alive = False

    def join(self, timeout=None):
        if not self._started:
            raise RuntimeError("cannot join thread before it is started")
        if self._handle is not None:
            try:
                self._result = self._handle.join()
            except RuntimeError as e:
                self._error = e
            self._alive = False
            self._handle = None
        if self._error is not None:
            raise self._error

    def run(self):
        if self._target:
            self._target(*self._args, **self._kwargs)


class Timer(Thread):
    def __init__(self, interval, function, args=None, kwargs=None):
        super().__init__(target=function, args=args or (), kwargs=kwargs)
        self.interval = interval

    def cancel(self):
        pass


# Module-level functions

def current_thread():
    return _main_thread

currentThread = current_thread


def main_thread():
    return _main_thread


def active_count():
    return 1

activeCount = active_count


def enumerate():
    return [_main_thread]


def get_ident():
    return 1


def get_native_id():
    return 1


class local:
    """Thread-local storage. In single-threaded WASM, just a regular object."""
    pass


# Factory functions
Lock = _DummyLock
RLock = _DummyRLock
Condition = _DummyCondition

TIMEOUT_MAX = 2**31

# _shutdown is called during interpreter finalization
def _shutdown():
    pass

# atexit callbacks registered by concurrent.futures
_atexit_callbacks = []

def _register_atexit(func):
    _atexit_callbacks.append(func)
