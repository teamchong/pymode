"""fcntl polyfill for WASM — file descriptor control operations."""

LOCK_SH = 1
LOCK_EX = 2
LOCK_NB = 4
LOCK_UN = 8
F_DUPFD = 0
F_GETFD = 1
F_SETFD = 2
F_GETFL = 3
F_SETFL = 4
F_GETLK = 5
F_SETLK = 6
F_SETLKW = 7
FD_CLOEXEC = 1
DN_ACCESS = 1
DN_MODIFY = 2
DN_CREATE = 4
DN_DELETE = 8
DN_RENAME = 16
DN_ATTRIB = 32
DN_MULTISHOT = 0x80000000

def fcntl(fd, cmd, arg=0):
    return 0

def ioctl(fd, request, arg=0, mutate_flag=True):
    return 0

def flock(fd, operation):
    pass

def lockf(fd, cmd, len=0, start=0, whence=0):
    pass
