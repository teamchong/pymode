"""Minimal select module shim for WASI.

Provides the select() and poll() interfaces needed by http.client,
urllib3, and other networking code. In WASI, actual I/O multiplexing
is not available, so these are no-ops or raise appropriate errors.
"""

error = OSError

POLLIN = 0x001
POLLPRI = 0x002
POLLOUT = 0x004
POLLERR = 0x008
POLLHUP = 0x010
POLLNVAL = 0x020


def select(rlist, wlist, xlist, timeout=None):
    """Minimal select — returns writable sockets immediately."""
    return ([], wlist[:], [])


class poll:
    """Minimal poll object."""
    def __init__(self):
        self._fds = {}

    def register(self, fd, eventmask=POLLIN | POLLOUT):
        self._fds[fd] = eventmask

    def unregister(self, fd):
        self._fds.pop(fd, None)

    def modify(self, fd, eventmask):
        self._fds[fd] = eventmask

    def poll(self, timeout=None):
        return [(fd, POLLOUT) for fd in self._fds]
