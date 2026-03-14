"""termios polyfill for WASM — terminal I/O control constants and no-op operations."""

class error(Exception): pass

TCSANOW = 0
TCSADRAIN = 1
TCSAFLUSH = 2

# Input flags
IGNBRK = 0o000001
BRKINT = 0o000002
IGNPAR = 0o000004
INPCK = 0o000020
ISTRIP = 0o000040
INLCR = 0o000100
IGNCR = 0o000200
ICRNL = 0o000400
IXON = 0o002000
IXOFF = 0o010000

# Output flags
OPOST = 0o000001

# Control flags
CSIZE = 0o000060
CS8 = 0o000060
CREAD = 0o000200
CLOCAL = 0o004000

# Local flags
ISIG = 0o000001
ICANON = 0o000002
ECHO = 0o000010
ECHOE = 0o000020
ECHOK = 0o000040
ECHONL = 0o000100
IEXTEN = 0o100000

B9600 = 0o000015
B38400 = 0o000017

def tcgetattr(fd):
    return [0, 0, 0, 0, B38400, B38400, [b'\x00'] * 32]

def tcsetattr(fd, when, attributes):
    pass

def tcsendbreak(fd, duration):
    pass

def tcdrain(fd):
    pass

def tcflush(fd, queue):
    pass

def tcflow(fd, action):
    pass
