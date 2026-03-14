"""syslog polyfill for WASM — redirects syslog calls to stderr."""
import sys

LOG_EMERG = 0
LOG_ALERT = 1
LOG_CRIT = 2
LOG_ERR = 3
LOG_WARNING = 4
LOG_NOTICE = 5
LOG_INFO = 6
LOG_DEBUG = 7

LOG_KERN = 0
LOG_USER = 8
LOG_MAIL = 16
LOG_DAEMON = 24
LOG_AUTH = 32
LOG_SYSLOG = 40
LOG_LPR = 48
LOG_NEWS = 56
LOG_UUCP = 64
LOG_CRON = 72
LOG_LOCAL0 = 128
LOG_LOCAL1 = 136
LOG_LOCAL2 = 144
LOG_LOCAL3 = 152
LOG_LOCAL4 = 160
LOG_LOCAL5 = 168
LOG_LOCAL6 = 176
LOG_LOCAL7 = 184

LOG_PID = 0x01
LOG_CONS = 0x02
LOG_NDELAY = 0x08
LOG_NOWAIT = 0x10
LOG_PERROR = 0x20

_ident = "python"

def openlog(ident="python", logoption=0, facility=LOG_USER):
    global _ident
    _ident = ident

def syslog(priority_or_message, message=None):
    if message is None:
        message = priority_or_message
    print(f"[{_ident}] {message}", file=sys.stderr)

def closelog():
    pass

def setlogmask(maskpri):
    return 255

def LOG_MASK(pri):
    return 1 << pri

def LOG_UPTO(pri):
    return (1 << (pri + 1)) - 1
