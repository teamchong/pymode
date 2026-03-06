"""Minimal _socket shim for WASI.

Provides the C-level constants that some packages check for.
The actual socket.py polyfill handles real socket operations.
"""

# Re-export everything from socket polyfill
from socket import *
from socket import _GLOBAL_DEFAULT_TIMEOUT, AddressFamily, SocketKind
