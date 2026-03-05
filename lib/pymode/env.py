"""PyMode environment — access CF bindings via host imports.

Provides KV, R2, D1, and environment variable access when running inside
PythonDO. Falls back gracefully when host imports are not available.

Usage:
    from pymode.env import KV, R2, D1, get_env

    # KV
    KV.put("key", b"value")
    data = KV.get("key")  # returns bytes or None

    # R2
    R2.put("file.bin", b"contents")
    data = R2.get("file.bin")  # returns bytes or None

    # D1
    rows = D1.execute("SELECT * FROM users WHERE id = ?", [42])

    # Environment variables
    secret = get_env("API_KEY")
"""

import json

_pymode = None
try:
    import _pymode as _pymode_mod
    _pymode = _pymode_mod
except ImportError:
    pass


class KV:
    @staticmethod
    def get(key: str) -> bytes | None:
        if _pymode is None:
            raise RuntimeError("KV requires PythonDO host imports (_pymode not available)")
        return _pymode.kv_get(key)

    @staticmethod
    def put(key: str, value: bytes):
        if _pymode is None:
            raise RuntimeError("KV requires PythonDO host imports (_pymode not available)")
        _pymode.kv_put(key, value)

    @staticmethod
    def delete(key: str):
        if _pymode is None:
            raise RuntimeError("KV requires PythonDO host imports (_pymode not available)")
        _pymode.kv_delete(key)


class R2:
    @staticmethod
    def get(key: str) -> bytes | None:
        if _pymode is None:
            raise RuntimeError("R2 requires PythonDO host imports (_pymode not available)")
        return _pymode.r2_get(key)

    @staticmethod
    def put(key: str, value: bytes):
        if _pymode is None:
            raise RuntimeError("R2 requires PythonDO host imports (_pymode not available)")
        _pymode.r2_put(key, value)


class D1:
    @staticmethod
    def execute(sql: str, params=None) -> list[dict]:
        if _pymode is None:
            raise RuntimeError("D1 requires PythonDO host imports (_pymode not available)")
        params_json = json.dumps(params or [])
        result = _pymode.d1_exec(sql, params_json)
        if result is None:
            return []
        return json.loads(result)


def get_env(key: str) -> str | None:
    if _pymode is None:
        import os
        return os.environ.get(key)
    return _pymode.env_get(key)


def console_log(msg: str):
    if _pymode is None:
        print(msg)
        return
    _pymode.console_log(msg)
