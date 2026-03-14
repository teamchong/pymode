"""faulthandler polyfill for WASM — no OS signals in sandboxed runtime."""

def enable(file=None, all_threads=True): pass
def disable(): pass
def is_enabled(): return False
def dump_traceback(file=None, all_threads=True): pass
def dump_traceback_later(timeout, repeat=False, file=None, exit=False): pass
def cancel_dump_traceback_later(): pass
def register(signum, file=None, all_threads=True, chain=False): pass
def unregister(signum): pass
