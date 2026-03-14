"""_ctypes polyfill for WASM — C foreign function interface.
Provides the types, constants, and functions that ctypes/__init__.py imports.
Loading shared libraries raises OSError since WASM has no dlopen.
"""
import struct as _struct

class error(OSError):
    pass

class ArgumentError(Exception):
    pass

FUNCFLAG_CDECL = 1
FUNCFLAG_PYTHONAPI = 4
FUNCFLAG_USE_ERRNO = 8
FUNCFLAG_USE_LASTERROR = 16
FUNCFLAG_STDCALL = 0
RTLD_LOCAL = 0
RTLD_GLOBAL = 256

__version__ = "1.1.0"
SIZEOF_TIME_T = 4

_errno_value = 0

def get_errno():
    return _errno_value

def set_errno(value):
    global _errno_value
    old = _errno_value
    _errno_value = value
    return old

def get_last_error():
    return 0

def set_last_error(value):
    return 0

def sizeof(obj):
    if hasattr(obj, '_length_') and hasattr(obj, '_type_'):
        return obj._length_ * sizeof(obj._type_)
    if hasattr(obj, '_fields_'):
        return sum(sizeof(f[1]) for f in obj._fields_)
    type_sizes = {'c': 1, 'b': 1, 'B': 1, 'h': 2, 'H': 2,
                  'i': 4, 'I': 4, 'l': 4, 'L': 4, 'q': 8, 'Q': 8,
                  'f': 4, 'd': 8, 'P': 4, 'z': 4, 'Z': 4}
    if hasattr(obj, '_type_') and obj._type_ in type_sizes:
        return type_sizes[obj._type_]
    return 4

def addressof(obj):
    raise error("ctypes: addressof not available in WASM")

def alignment(obj_or_type):
    return 4

def resize(obj, size):
    raise error("ctypes: resize not available in WASM")

def byref(obj, offset=0):
    raise error("ctypes: byref not available in WASM")

_memmove_addr = 0
_memset_addr = 0
_string_at_addr = 0
_cast_addr = 0
_wstring_at_addr = 0

def _check_HRESULT(value):
    return value

def FormatError(code=None):
    return f"Error {code}"

def LoadLibrary(name, mode=RTLD_LOCAL):
    raise error(f"ctypes: cannot load shared library '{name}' — no dlopen in WASM")

def dlopen(name, mode=RTLD_LOCAL):
    raise error(f"ctypes: cannot load shared library '{name}' — no dlopen in WASM")

class _CData:
    _b_base_ = 0
    _b_needsfree_ = 0
    _objects = None

class Structure(_CData):
    _fields_ = []
    def __init__(self, *args, **kwargs):
        for i, (name, tp, *rest) in enumerate(self._fields_):
            if i < len(args):
                setattr(self, name, args[i])
            elif name in kwargs:
                setattr(self, name, kwargs[name])

class Union(_CData):
    _fields_ = []

class Array(_CData):
    _length_ = 0
    _type_ = None

class _Pointer(_CData):
    _type_ = None
    contents = None

class _SimpleCData(_CData):
    _type_ = 'i'
    value = 0
    def __init__(self, value=0):
        self.value = value

class CFuncPtr(_CData):
    _flags_ = FUNCFLAG_CDECL
    _restype_ = None
    _argtypes_ = ()

_pointer_type_cache = {}

def POINTER(cls):
    if cls in _pointer_type_cache:
        return _pointer_type_cache[cls]
    klass = type(f"LP_{getattr(cls, '__name__', id(cls))}", (_Pointer,), {"_type_": cls})
    _pointer_type_cache[cls] = klass
    return klass

def pointer(obj):
    raise error("ctypes: pointer not available in WASM")

class CDLL:
    def __init__(self, name, mode=RTLD_LOCAL, handle=None, use_errno=False, use_last_error=False):
        raise error(f"ctypes: cannot load shared library '{name}' — no dlopen in WASM")

class PyDLL(CDLL):
    pass
