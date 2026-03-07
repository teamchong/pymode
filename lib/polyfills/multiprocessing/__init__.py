"""Minimal multiprocessing polyfill for WASM environments.

WASM has no process model, but packages like langsmith only need
cpu_count() at import time. This provides just enough to unblock imports.
"""

import os


def cpu_count():
    """Return 1 — single-threaded WASM has one logical core."""
    return 1


class AuthenticationError(Exception):
    pass


class BufferTooShort(Exception):
    pass


class ProcessError(Exception):
    pass


class TimeoutError(Exception):
    pass
