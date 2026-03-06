"""Socket module shim for PyMode WASM runtime.

Routes socket operations through pymode.tcp host imports instead of
OS-level sockets (unavailable in WASI). This allows packages that
import socket (psycopg2, redis, httpx, etc.) to load and work.

When pymode.tcp.install() has been called, socket.socket is already
patched to PyModeSocket. This module provides the module-level
constants and functions that packages check at import time.
"""

import sys
import enum

# Address families
AF_INET = 2
AF_INET6 = 10
AF_UNIX = 1
AF_UNSPEC = 0

class AddressFamily(enum.IntEnum):
    AF_UNIX = 1
    AF_INET = 2
    AF_INET6 = 10
    AF_UNSPEC = 0

class SocketKind(enum.IntEnum):
    SOCK_STREAM = 1
    SOCK_DGRAM = 2
    SOCK_RAW = 3

# Socket types
SOCK_STREAM = 1
SOCK_DGRAM = 2
SOCK_RAW = 3

# Protocols
IPPROTO_TCP = 6
IPPROTO_UDP = 17
IPPROTO_IP = 0

# Socket options
SOL_SOCKET = 1
SO_REUSEADDR = 2
SO_KEEPALIVE = 9
SO_ERROR = 4
SO_LINGER = 13
TCP_NODELAY = 1
SOL_TCP = 6

# Misc
SHUT_RD = 0
SHUT_WR = 1
SHUT_RDWR = 2
AI_PASSIVE = 1
AI_CANONNAME = 2
AI_NUMERICHOST = 4
NI_NUMERICHOST = 1
NI_NUMERICSERV = 2
INADDR_ANY = 0
INADDR_LOOPBACK = 0x7F000001

# Default timeout sentinel
_GLOBAL_DEFAULT_TIMEOUT = object()

# Errors
error = OSError
herror = OSError
gaierror = OSError
timeout = TimeoutError

# Has IPv6?
has_ipv6 = False

# EAI error codes
EAI_NONAME = -2


def _load_pymode_socket():
    """Import and return pymode.tcp.PyModeSocket."""
    from pymode.tcp import PyModeSocket
    return PyModeSocket


class socket:
    """Socket class that delegates to pymode.tcp.PyModeSocket."""

    def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, fileno=None):
        cls = _load_pymode_socket()
        self._sock = cls(family=family, type=type, proto=proto, fileno=fileno)

    def __getattr__(self, name):
        return getattr(self._sock, name)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self._sock.close()


def create_connection(address, timeout=None, source_address=None):
    sock = socket(AF_INET, SOCK_STREAM)
    if timeout is not None:
        sock.settimeout(timeout)
    sock.connect(address)
    return sock


def getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    """Minimal getaddrinfo that returns a single IPv4 TCP result."""
    port = int(port) if port else 0
    return [(AF_INET, SOCK_STREAM, IPPROTO_TCP, '', (host, port))]


def gethostname():
    return "pymode-worker"


def gethostbyname(hostname):
    return hostname


def getfqdn(name=""):
    return name or "pymode-worker"


def inet_aton(ip_string):
    parts = ip_string.split(".")
    return bytes(int(p) for p in parts)


def inet_ntoa(packed_ip):
    return ".".join(str(b) for b in packed_ip)


def getdefaulttimeout():
    return None


def setdefaulttimeout(timeout):
    pass


def socketpair(family=AF_UNIX, type=SOCK_STREAM, proto=0):
    raise OSError("socketpair not available in WASM runtime")
