"""Pure Python _weakref — replacement for the C extension module.

Provides the _weakref API needed by copy.py and weakref.py.
In WASM single-threaded CPython, weak references hold strong references
since the GC callback machinery requires the C module. This is correct
for all non-GC use cases (memoization, caching, copy memo dicts).

Reference: metal0/packages/runtime/src/Lib/weakref/ (full Zig equivalent).
"""


class ref:
    """Weak reference that holds a strong reference in WASM CPython.

    The GC-integrated weak reference behavior requires C-level support
    for tp_weaklistoffset and callback invocation on dealloc. In pure
    Python, we implement the full ref API with strong retention.
    """

    __slots__ = ("_obj", "_callback")

    def __init__(self, obj, callback=None):
        self._obj = obj
        self._callback = callback

    def __call__(self):
        return self._obj

    def __repr__(self):
        if self._obj is not None:
            return f"<weakref at {id(self):#x}; to '{type(self._obj).__name__}'>"
        return f"<weakref at {id(self):#x}; dead>"

    def __hash__(self):
        return hash(self._obj)

    def __eq__(self, other):
        if isinstance(other, ref):
            return self._obj == other._obj
        return NotImplemented


ReferenceType = ref


class _ProxyBase:
    """Proxy that delegates all operations to the referent."""

    __slots__ = ("_ref",)

    def __init__(self, obj, callback=None):
        object.__setattr__(self, "_ref", ref(obj, callback))

    def _get(self):
        obj = object.__getattribute__(self, "_ref")()
        if obj is None:
            raise ReferenceError("weakly-referenced object no longer exists")
        return obj

    def __getattr__(self, name):
        return getattr(self._get(), name)

    def __setattr__(self, name, value):
        setattr(self._get(), name, value)

    def __delattr__(self, name):
        delattr(self._get(), name)

    def __repr__(self):
        return repr(self._get())

    def __str__(self):
        return str(self._get())

    def __bytes__(self):
        return bytes(self._get())

    def __hash__(self):
        return hash(self._get())

    def __bool__(self):
        return bool(self._get())

    def __len__(self):
        return len(self._get())

    def __contains__(self, item):
        return item in self._get()

    def __iter__(self):
        return iter(self._get())

    def __next__(self):
        return next(self._get())

    def __eq__(self, other):
        return self._get() == other

    def __ne__(self, other):
        return self._get() != other

    def __lt__(self, other):
        return self._get() < other

    def __le__(self, other):
        return self._get() <= other

    def __gt__(self, other):
        return self._get() > other

    def __ge__(self, other):
        return self._get() >= other

    def __add__(self, other):
        return self._get() + other

    def __sub__(self, other):
        return self._get() - other

    def __mul__(self, other):
        return self._get() * other

    def __getitem__(self, key):
        return self._get()[key]

    def __setitem__(self, key, value):
        self._get()[key] = value

    def __delitem__(self, key):
        del self._get()[key]


class _CallableProxy(_ProxyBase):
    """Proxy for callable objects."""

    def __call__(self, *args, **kwargs):
        return self._get()(*args, **kwargs)


ProxyType = _ProxyBase
CallableProxyType = _CallableProxy


def proxy(obj, callback=None):
    """Create a proxy object that delegates to obj."""
    if callable(obj):
        return _CallableProxy(obj, callback)
    return _ProxyBase(obj, callback)


def getweakrefcount(obj):
    """Return the number of weak references to obj."""
    return 0


def getweakrefs(obj):
    """Return a list of all weak reference objects to obj."""
    return []


def _remove_dead_weakref(d, key):
    """Remove a dead weak reference from dict d for the given key.

    Called by WeakValueDictionary to clean up entries whose referents
    have been collected. In our strong-reference implementation, referents
    are never collected, so this is a no-op.
    """
    pass
