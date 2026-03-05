"""PyMode TCP bridge — enables database drivers via re-execution trampoline.

Same pattern as pymode.http: Python queues TCP session requests to VFS,
exits with code 254, and the JS host executes them via cloudflare:sockets.

Usage:
    import pymode.tcp
    pymode.tcp.install()  # patches socket module

    # Then use any database driver normally:
    import psycopg2
    conn = psycopg2.connect(...)
"""

import os
import json
import sys
import base64


PENDING_PATH = "/stdlib/tmp/_pymode_pending_tcp.json"
RESPONSE_DIR = "/stdlib/tmp/_pymode_tcp"

_session_counter = 0


def _next_session_id():
    global _session_counter
    _session_counter += 1
    return f"tcp_{_session_counter}"


class TCPResponse:
    """Response from a TCP send/recv cycle."""

    def __init__(self, data):
        self.data = data
        self._offset = 0

    def read(self, amt=-1):
        if amt < 0:
            result = self.data[self._offset:]
            self._offset = len(self.data)
            return result
        result = self.data[self._offset:self._offset + amt]
        self._offset += amt
        return result


class PyModeSocket:
    """Drop-in socket replacement that routes through the trampoline.

    Buffers all sends, then on recv() either returns a cached response
    (from a previous trampoline round) or queues the session and exits 254.
    """

    AF_INET = 2
    SOCK_STREAM = 1

    def __init__(self, family=AF_INET, type=SOCK_STREAM, proto=0, fileno=None):
        self.family = family
        self.type = type
        self._host = None
        self._port = None
        self._session_id = _next_session_id()
        self._send_buffer = []
        self._connected = False
        self._timeout = None

    def connect(self, addr):
        self._host, self._port = addr
        self._connected = True

    def connect_ex(self, addr):
        self.connect(addr)
        return 0

    def settimeout(self, timeout):
        self._timeout = timeout

    def gettimeout(self):
        return self._timeout

    def setblocking(self, flag):
        self._timeout = None if flag else 0.0

    def setsockopt(self, level, optname, value):
        pass  # No-op on WASM

    def getsockopt(self, level, optname, buflen=None):
        return 0

    def fileno(self):
        return -1

    def getpeername(self):
        return (self._host, self._port)

    def getsockname(self):
        return ("0.0.0.0", 0)

    def sendall(self, data, flags=0):
        self._send_buffer.append(data if isinstance(data, bytes) else bytes(data))
        return None

    def send(self, data, flags=0):
        self._send_buffer.append(data if isinstance(data, bytes) else bytes(data))
        return len(data)

    def recv(self, bufsize, flags=0):
        resp_path = f"{RESPONSE_DIR}/{self._session_id}"

        # Response already fetched by JS in a previous trampoline round
        if os.path.exists(resp_path):
            with open(resp_path, "rb") as f:
                data = json.load(f)
            body = base64.b64decode(data["dataBase64"])
            # Clear for next recv cycle
            os.unlink(resp_path)
            self._send_buffer = []
            return body[:bufsize]

        # Queue TCP session: connect + send all buffered data + recv
        pending = []
        if os.path.exists(PENDING_PATH):
            with open(PENDING_PATH) as f:
                pending = json.load(f)

        send_data = b"".join(self._send_buffer)
        pending.append({
            "sessionId": self._session_id,
            "host": self._host,
            "port": self._port,
            "sendDataBase64": base64.b64encode(send_data).decode("ascii"),
            "recvSize": bufsize,
        })

        pending_dir = os.path.dirname(PENDING_PATH)
        if not os.path.exists(pending_dir):
            os.makedirs(pending_dir, exist_ok=True)
        with open(PENDING_PATH, "w") as f:
            json.dump(pending, f)

        sys.exit(254)

    def recv_into(self, buffer, nbytes=0, flags=0):
        data = self.recv(nbytes or len(buffer), flags)
        n = len(data)
        buffer[:n] = data
        return n

    def makefile(self, mode="r", buffering=-1, **kwargs):
        # Many DB drivers call sock.makefile()
        import io
        if "b" in mode:
            return _SocketIO(self, mode)
        return io.TextIOWrapper(_SocketIO(self, mode), **kwargs)

    def shutdown(self, how):
        pass

    def close(self):
        self._connected = False
        self._send_buffer = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class _SocketIO:
    """Minimal file-like wrapper over PyModeSocket for makefile()."""

    def __init__(self, sock, mode):
        self._sock = sock
        self.mode = mode

    def read(self, n=-1):
        if n < 0:
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

    def flush(self):
        pass

    def close(self):
        pass

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


def _create_connection(address, timeout=None, source_address=None):
    sock = PyModeSocket()
    if timeout is not None:
        sock.settimeout(timeout)
    sock.connect(address)
    return sock
