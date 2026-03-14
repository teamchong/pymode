"""grp polyfill for WASM — POSIX group database interface."""

import collections

struct_group = collections.namedtuple('struct_group', ['gr_name', 'gr_passwd', 'gr_gid', 'gr_mem'])

def getgrall():
    return []

def getgrgid(gid):
    raise KeyError(f"getgrgid(): gid not found: {gid}")

def getgrnam(name):
    raise KeyError(f"getgrnam(): name not found: {name!r}")
