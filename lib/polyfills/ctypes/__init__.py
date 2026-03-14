"""ctypes polyfill for WASM — C foreign function interface.
Provides the public API that packages expect from ctypes.
Loading shared libraries raises OSError since WASM has no dlopen.
"""

from _ctypes import (
    error, ArgumentError,
    FUNCFLAG_CDECL, FUNCFLAG_PYTHONAPI, FUNCFLAG_USE_ERRNO,
    FUNCFLAG_USE_LASTERROR, FUNCFLAG_STDCALL,
    RTLD_LOCAL, RTLD_GLOBAL,
    get_errno, set_errno, get_last_error, set_last_error,
    sizeof, byref, addressof, alignment, resize,
    Structure, Union, Array, _Pointer, _SimpleCData, _CData, CFuncPtr,
    POINTER, pointer, _pointer_type_cache,
    CDLL, PyDLL,
    LoadLibrary, dlopen,
    FormatError, _check_HRESULT,
    _memmove_addr, _memset_addr, _string_at_addr, _cast_addr, _wstring_at_addr,
)

__version__ = "1.1.0"

# --- Simple C types ---

class py_object(_SimpleCData):
    _type_ = "O"

class c_short(_SimpleCData):
    _type_ = "h"

class c_ushort(_SimpleCData):
    _type_ = "H"

class c_long(_SimpleCData):
    _type_ = "l"

class c_ulong(_SimpleCData):
    _type_ = "L"

c_int = c_long
c_uint = c_ulong

class c_float(_SimpleCData):
    _type_ = "f"

class c_double(_SimpleCData):
    _type_ = "d"

c_longdouble = c_double

class c_longlong(_SimpleCData):
    _type_ = "q"

class c_ulonglong(_SimpleCData):
    _type_ = "Q"

class c_ubyte(_SimpleCData):
    _type_ = "B"

class c_byte(_SimpleCData):
    _type_ = "b"

class c_char(_SimpleCData):
    _type_ = "c"

class c_char_p(_SimpleCData):
    _type_ = "z"

class c_void_p(_SimpleCData):
    _type_ = "P"

c_voidp = c_void_p

class c_bool(_SimpleCData):
    _type_ = "?"
    def __init__(self, value=False):
        self.value = bool(value)

class c_wchar(_SimpleCData):
    _type_ = "u"

class c_wchar_p(_SimpleCData):
    _type_ = "Z"

# Size types
c_size_t = c_uint
c_ssize_t = c_int
c_int8 = c_byte
c_int16 = c_short
c_int32 = c_int
c_int64 = c_longlong
c_uint8 = c_ubyte
c_uint16 = c_ushort
c_uint32 = c_uint
c_uint64 = c_ulonglong

_pointer_type_cache[None] = c_void_p

# --- Function types ---

def CFUNCTYPE(restype, *argtypes, **kw):
    """Create a C callable function type with cdecl calling convention."""
    class CFunctionType(CFuncPtr):
        _argtypes_ = argtypes
        _restype_ = restype
        _flags_ = FUNCFLAG_CDECL
        def __init__(self, func_or_addr=None, *args, **kwargs):
            if callable(func_or_addr):
                self._func = func_or_addr
            else:
                self._addr = func_or_addr
        def __call__(self, *args, **kwargs):
            if hasattr(self, '_func') and self._func is not None:
                return self._func(*args, **kwargs)
            raise error("ctypes: cannot call C function in WASM")
    CFunctionType.__name__ = f"CFunctionType_{id(restype)}"
    return CFunctionType

def WINFUNCTYPE(restype, *argtypes, **kw):
    return CFUNCTYPE(restype, *argtypes, **kw)

# --- Buffer creation ---

def create_string_buffer(init, size=None):
    if isinstance(init, bytes):
        if size is None:
            size = len(init) + 1
        buf = type("c_char_Array", (Array,), {"_type_": c_char, "_length_": size})()
        buf.value = init
        return buf
    elif isinstance(init, int):
        return type("c_char_Array", (Array,), {"_type_": c_char, "_length_": init})()
    raise TypeError(init)

c_buffer = create_string_buffer

def create_unicode_buffer(init, size=None):
    if isinstance(init, str):
        if size is None:
            size = len(init) + 1
        buf = type("c_wchar_Array", (Array,), {"_type_": c_wchar, "_length_": size})()
        buf.value = init
        return buf
    elif isinstance(init, int):
        return type("c_wchar_Array", (Array,), {"_type_": c_wchar, "_length_": init})()
    raise TypeError(init)

# --- Utility functions ---

def cast(obj, typ):
    raise error("ctypes: cast not available in WASM")

def string_at(ptr, size=-1):
    raise error("ctypes: string_at not available in WASM")

def wstring_at(ptr, size=-1):
    raise error("ctypes: wstring_at not available in WASM")

def memmove(dst, src, count):
    raise error("ctypes: memmove not available in WASM")

def memset(dst, c, count):
    raise error("ctypes: memset not available in WASM")

def SetPointerType(pointer, cls):
    pointer._type_ = cls

def ARRAY(typ, length):
    return typ * length

def _reset_cache():
    _pointer_type_cache.clear()
    _pointer_type_cache[None] = c_void_p

# --- Library loaders ---

class LibraryLoader:
    def __init__(self, dlltype):
        self._dlltype = dlltype
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self._dlltype(name)
    def __getitem__(self, name):
        return self._dlltype(name)
    def LoadLibrary(self, name):
        return self._dlltype(name)

cdll = LibraryLoader(CDLL)
pydll = LibraryLoader(PyDLL)

class WinDLL(CDLL):
    pass

class OleDLL(CDLL):
    pass

windll = LibraryLoader(WinDLL)
oledll = LibraryLoader(OleDLL)

# pythonapi — CDLL(None) pretends to be the current process
pythonapi = PyDLL(None)

# --- Endian structures ---

class BigEndianStructure(Structure):
    pass

class LittleEndianStructure(Structure):
    pass

class BigEndianUnion(Union):
    pass

class LittleEndianUnion(Union):
    pass

