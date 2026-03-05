"""PyMode TCP bridge — full stateful TCP via re-execution trampoline.

Supports multi-step protocols (PostgreSQL auth, MySQL handshake, etc.)
by keeping TCP connections alive across trampoline rounds on the JS side.

Architecture:
  - Python records a log of all socket operations (connect, send, recv, close)
    to /tmp/_pymode_tcp_ops.json
  - On recv(), Python checks for a cached response. If found, returns it.
    If not, writes the ops log and exits 254.
  - JS replays ALL operations from the log on persistent connections:
    connect (reuse if already open), send, recv (write response to VFS), close.
  - Python restarts, replays its code, hits the same recv(), finds the
    cached response, and continues to the next operation.

This works because:
  - Database protocols are deterministic given the same inputs
  - The ops log captures the full conversation history
  - JS replays the entire conversation each round, keeping connections open
  - Each new recv() that doesn't have a cached response triggers one more round

Usage:
    import pymode.tcp
    pymode.tcp.install()  # patches socket module

    # Then use any database driver normally:
    import psycopg2
    conn = psycopg2.connect(host="db.example.com", ...)
    cur = conn.cursor()
    cur.execute("SELECT 1")
"""

import os
import json
import sys
import base64
import io


PENDING_PATH = "/stdlib/tmp/_pymode_tcp_ops.json"
RESPONSE_DIR = "/stdlib/tmp/_pymode_tcp_responses"

# Global operation counter — used to identify which recv we're at.
# This resets on each Python re-execution, which is correct because
# Python replays the same code path and hits recv() in the same order.
_recv_counter = 0


class PyModeSocket:
    """Drop-in socket replacement that routes through the trampoline.

    Records all operations. On recv(), checks for a cached response from a
    previous trampoline round. If not found, writes the full ops log and
    exits 254 so JS can replay the conversation and provide the response.
    """

    AF_INET = 2
    AF_INET6 = 10
    SOCK_STREAM = 1

    # Global ops log shared across all sockets in this execution
    _ops_log = []
    # Connection ID counter
    _next_conn_id = 0

    def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, fileno=None):
        self.family = family
        self.type = type
        self._host = None
        self._port = None
        self._connected = False
        self._timeout = None
        self._closed = False

        PyModeSocket._next_conn_id += 1
        self._conn_id = f"conn_{PyModeSocket._next_conn_id}"

    def connect(self, addr):
        self._host, self._port = addr[0], addr[1]
        self._connected = True
        PyModeSocket._ops_log.append({
            "op": "connect",
            "connId": self._conn_id,
            "host": self._host,
            "port": self._port,
        })

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
        PyModeSocket._ops_log.append({
            "op": "send",
            "connId": self._conn_id,
            "dataBase64": base64.b64encode(raw).decode("ascii"),
        })
        return None

    def send(self, data, flags=0):
        raw = data if isinstance(data, bytes) else bytes(data)
        PyModeSocket._ops_log.append({
            "op": "send",
            "connId": self._conn_id,
            "dataBase64": base64.b64encode(raw).decode("ascii"),
        })
        return len(raw)

    def recv(self, bufsize, flags=0):
        global _recv_counter
        recv_id = _recv_counter
        _recv_counter += 1

        resp_path = f"{RESPONSE_DIR}/{recv_id}"

        # Response already fetched by JS in a previous trampoline round
        if os.path.exists(resp_path):
            with open(resp_path, "rb") as f:
                data = json.load(f)
            if data.get("error"):
                raise OSError(f"TCP error: {data['error']}")
            body = base64.b64decode(data["dataBase64"])
            # Log this recv so future rounds see the full conversation
            PyModeSocket._ops_log.append({
                "op": "recv",
                "connId": self._conn_id,
                "recvId": recv_id,
                "bufsize": bufsize,
            })
            return body[:bufsize]

        # No cached response — log the recv and exit for JS to handle
        PyModeSocket._ops_log.append({
            "op": "recv",
            "connId": self._conn_id,
            "recvId": recv_id,
            "bufsize": bufsize,
        })

        # Write the full ops log
        pending_dir = os.path.dirname(PENDING_PATH)
        if not os.path.exists(pending_dir):
            os.makedirs(pending_dir, exist_ok=True)
        with open(PENDING_PATH, "w") as f:
            json.dump(PyModeSocket._ops_log, f)

        sys.exit(254)

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
            PyModeSocket._ops_log.append({
                "op": "close",
                "connId": self._conn_id,
            })

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

    # Also patch constants that some drivers check
    _socket_mod.AF_INET = PyModeSocket.AF_INET
    _socket_mod.AF_INET6 = PyModeSocket.AF_INET6
    _socket_mod.SOCK_STREAM = PyModeSocket.SOCK_STREAM


def _create_connection(address, timeout=None, source_address=None):
    sock = PyModeSocket()
    if timeout is not None:
        sock.settimeout(timeout)
    sock.connect(address)
    return sock
