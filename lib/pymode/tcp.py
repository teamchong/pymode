"""PyMode TCP bridge — host imports for direct TCP via PythonDO.

When running inside PythonDO, TCP calls go through WASM host imports
(the _pymode C extension module). The JS host holds persistent TCP
connections in the DO and handles async recv via trampoline or JSPI.

When _pymode is not available (legacy VFS trampoline mode), falls back
to the original ops-log approach with sys.exit(254).

Usage:
    import pymode.tcp
    pymode.tcp.install()  # patches socket module

    # Then use any database driver normally:
    import psycopg2
    conn = psycopg2.connect(host="db.example.com", ...)
"""

import io
import sys

# Try to import the host imports C module (available in PythonDO mode)
_pymode = None
try:
    import _pymode
except ImportError:
    pass


def _use_host_imports():
    """Check if host imports are available (running inside PythonDO)."""
    return _pymode is not None


class PyModeSocket:
    """Drop-in socket replacement that routes through host imports or VFS trampoline."""

    AF_INET = 2
    AF_INET6 = 10
    SOCK_STREAM = 1

    def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, fileno=None):
        self.family = family
        self.type = type
        self._host = None
        self._port = None
        self._conn_id = -1
        self._connected = False
        self._timeout = None
        self._closed = False

    def connect(self, addr):
        self._host, self._port = addr[0], addr[1]
        if _use_host_imports():
            self._conn_id = _pymode.tcp_connect(self._host, self._port)
        else:
            self._conn_id = _legacy_connect(self._host, self._port)
        self._connected = True

    def connect_ex(self, addr):
        try:
            self.connect(addr)
            return 0
        except OSError as e:
            return e.errno or -1

    def settimeout(self, timeout):
        self._timeout = timeout

    def gettimeout(self):
        return self._timeout

    def setblocking(self, flag):
        self._timeout = None if flag else 0.0

    def setsockopt(self, level, optname, value, optlen=None):
        pass

    def getsockopt(self, level, optname, buflen=None):
        return 0

    def fileno(self):
        return -1

    def getpeername(self):
        return (self._host, self._port)

    def getsockname(self):
        return ("0.0.0.0", 0)

    def sendall(self, data, flags=0):
        raw = data if isinstance(data, bytes) else bytes(data)
        if _use_host_imports():
            _pymode.tcp_send(self._conn_id, raw)
        else:
            _legacy_send(self._conn_id, raw)
        return None

    def send(self, data, flags=0):
        raw = data if isinstance(data, bytes) else bytes(data)
        if _use_host_imports():
            return _pymode.tcp_send(self._conn_id, raw)
        else:
            return _legacy_send(self._conn_id, raw)

    def recv(self, bufsize, flags=0):
        if _use_host_imports():
            return _pymode.tcp_recv(self._conn_id, bufsize)
        else:
            return _legacy_recv(self._conn_id, bufsize)

    def recv_into(self, buffer, nbytes=0, flags=0):
        data = self.recv(nbytes or len(buffer), flags)
        n = len(data)
        buffer[:n] = data
        return n

    def makefile(self, mode="r", buffering=-1, **kwargs):
        if "b" in mode:
            return _SocketIO(self, mode)
        return io.TextIOWrapper(_SocketIO(self, mode), **kwargs)

    def shutdown(self, how):
        pass

    def close(self):
        if not self._closed:
            self._closed = True
            self._connected = False
            if _use_host_imports():
                if self._conn_id >= 0:
                    _pymode.tcp_close(self._conn_id)
            else:
                _legacy_close(self._conn_id)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __del__(self):
        if not self._closed:
            self.close()


class _SocketIO(io.RawIOBase):
    """File-like wrapper over PyModeSocket for makefile()."""

    def __init__(self, sock, mode):
        self._sock = sock
        self.mode = mode

    def read(self, n=-1):
        if n is None or n < 0:
            n = 65536
        return self._sock.recv(n)

    def readinto(self, b):
        data = self._sock.recv(len(b))
        n = len(data)
        b[:n] = data
        return n

    def write(self, data):
        self._sock.sendall(data)
        return len(data)

    def readable(self):
        return True

    def writable(self):
        return True

    def seekable(self):
        return False


# --- Legacy VFS trampoline fallback ---
# Used when _pymode C module is not available (old Worker mode without DO).
# Records ops to a JSON file, exits 254, JS replays and writes responses.

import os
import json
import base64

_PENDING_PATH = "/stdlib/tmp/_pymode_tcp_ops.json"
_RESPONSE_DIR = "/stdlib/tmp/_pymode_tcp_responses"
_recv_counter = 0
_ops_log = []
_next_legacy_conn_id = 0


def _legacy_connect(host, port):
    global _next_legacy_conn_id
    _next_legacy_conn_id += 1
    conn_id = _next_legacy_conn_id
    _ops_log.append({
        "op": "connect",
        "connId": f"conn_{conn_id}",
        "host": host,
        "port": port,
    })
    return conn_id


def _legacy_send(conn_id, data):
    _ops_log.append({
        "op": "send",
        "connId": f"conn_{conn_id}",
        "dataBase64": base64.b64encode(data).decode("ascii"),
    })
    return len(data)


def _legacy_recv(conn_id, bufsize):
    global _recv_counter
    recv_id = _recv_counter
    _recv_counter += 1

    resp_path = f"{_RESPONSE_DIR}/{recv_id}"

    if os.path.exists(resp_path):
        with open(resp_path, "rb") as f:
            data = json.load(f)
        if data.get("error"):
            raise OSError(f"TCP error: {data['error']}")
        body = base64.b64decode(data["dataBase64"])
        _ops_log.append({
            "op": "recv",
            "connId": f"conn_{conn_id}",
            "recvId": recv_id,
            "bufsize": bufsize,
        })
        return body[:bufsize]

    _ops_log.append({
        "op": "recv",
        "connId": f"conn_{conn_id}",
        "recvId": recv_id,
        "bufsize": bufsize,
    })

    pending_dir = os.path.dirname(_PENDING_PATH)
    if not os.path.exists(pending_dir):
        os.makedirs(pending_dir, exist_ok=True)
    with open(_PENDING_PATH, "w") as f:
        json.dump(_ops_log, f)

    sys.exit(254)


def _legacy_close(conn_id):
    _ops_log.append({
        "op": "close",
        "connId": f"conn_{conn_id}",
    })


# --- Socket module patching ---

_installed = False


def install():
    """Patch the socket module to use PyModeSocket.

    Safe to call multiple times; only patches once.
    """
    global _installed
    if _installed:
        return
    _installed = True

    import socket as _socket_mod
    _socket_mod.socket = PyModeSocket
    _socket_mod.create_connection = _create_connection

    _socket_mod.AF_INET = PyModeSocket.AF_INET
    _socket_mod.AF_INET6 = PyModeSocket.AF_INET6
    _socket_mod.SOCK_STREAM = PyModeSocket.SOCK_STREAM


def _create_connection(address, timeout=None, source_address=None):
    sock = PyModeSocket()
    if timeout is not None:
        sock.settimeout(timeout)
    sock.connect(address)
    return sock
