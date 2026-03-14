"""_ctypes polyfill for WASM — C foreign function interface.
Provides the types and constants that ctypes/__init__.py imports.
Loading shared libraries raises OSError since WASM has no dlopen.
"""

class error(OSError):
    pass

FUNCFLAG_CDECL = 1
FUNCFLAG_PYTHONAPI = 4
FUNCFLAG_USE_ERRNO = 8
FUNCFLAG_USE_LASTERROR = 16
RTLD_LOCAL = 0
RTLD_GLOBAL = 256

def sizeof(obj):
    raise error("ctypes: sizeof not available in WASM")

def addressof(obj):
    raise error("ctypes: addressof not available in WASM")

def alignment(obj_or_type):
    raise error("ctypes: alignment not available in WASM")

class _CData:
    pass

class Structure(_CData):
    pass

class Union(_CData):
    pass

class Array(_CData):
    pass

class _Pointer(_CData):
    pass

class _SimpleCData(_CData):
    pass

class CFuncPtr(_CData):
    pass

def POINTER(cls):
    return type(f"LP_{cls.__name__}", (_Pointer,), {"_type_": cls})

def pointer(obj):
    raise error("ctypes: pointer not available in WASM")

def CFUNCTYPE(restype, *argtypes, use_errno=False, use_last_error=False):
    return type("CFunctionType", (CFuncPtr,), {})

class CDLL:
    def __init__(self, name, mode=RTLD_LOCAL, handle=None, use_errno=False, use_last_error=False):
        raise error(f"ctypes: cannot load shared library '{name}' — no dlopen in WASM")

class PyDLL(CDLL):
    pass
