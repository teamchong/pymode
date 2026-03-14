"""resource polyfill for WASM — provides resource limit constants and safe defaults."""

import collections

RLIMIT_CPU = 0
RLIMIT_FSIZE = 1
RLIMIT_DATA = 2
RLIMIT_STACK = 3
RLIMIT_CORE = 4
RLIMIT_RSS = 5
RLIMIT_NPROC = 6
RLIMIT_NOFILE = 7
RLIMIT_MEMLOCK = 8
RLIMIT_AS = 9
RLIM_INFINITY = -1
RUSAGE_SELF = 0
RUSAGE_CHILDREN = -1

class error(OSError): pass

_rusage_fields = ('ru_utime', 'ru_stime', 'ru_maxrss', 'ru_ixrss', 'ru_idrss',
                  'ru_isrss', 'ru_minflt', 'ru_majflt', 'ru_nswap', 'ru_inblock',
                  'ru_oublock', 'ru_msgsnd', 'ru_msgrcv', 'ru_nsignals',
                  'ru_nvcsw', 'ru_nivcsw')
_RUsage = collections.namedtuple('struct_rusage', _rusage_fields)

def getrlimit(resource):
    return (RLIM_INFINITY, RLIM_INFINITY)

def setrlimit(resource, limits):
    pass

def getrusage(who):
    return _RUsage(*(0.0 if i < 2 else 0 for i in range(16)))

def getpagesize():
    return 65536
