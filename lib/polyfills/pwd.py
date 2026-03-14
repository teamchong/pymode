"""pwd polyfill for WASM — POSIX password database interface."""

import collections

struct_passwd = collections.namedtuple('struct_passwd',
    ['pw_name', 'pw_passwd', 'pw_uid', 'pw_gid', 'pw_gecos', 'pw_dir', 'pw_shell'])

def getpwuid(uid):
    if uid == 0:
        return struct_passwd('root', 'x', 0, 0, 'root', '/', '/bin/sh')
    raise KeyError(f"getpwuid(): uid not found: {uid}")

def getpwnam(name):
    if name == 'root':
        return struct_passwd('root', 'x', 0, 0, 'root', '/', '/bin/sh')
    raise KeyError(f"getpwnam(): name not found: {name!r}")

def getpwall():
    return [struct_passwd('root', 'x', 0, 0, 'root', '/', '/bin/sh')]
