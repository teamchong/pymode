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
    import _pymode
except ImportError:
    pass


class KV:
    @staticmethod
    def get(key: str) -> bytes | None:
        if _pymode is None:
            raise RuntimeError("KV requires PythonDO host imports (_pymode not available)")
        return _pymode.kv_get(key)

    @staticmethod
    def multi_get(keys: list[str]) -> list[bytes | None]:
        """Get multiple keys in one Asyncify call. Returns list matching input order."""
        import struct
        if _pymode is None:
            raise RuntimeError("KV requires PythonDO host imports (_pymode not available)")
        keys_json = json.dumps(keys)
        buf = _pymode.kv_multi_get(keys_json)
        # Parse: [4B count][for each: [4B len (-1=missing)][data]]
        count = struct.unpack_from("<i", buf, 0)[0]
        results = []
        offset = 4
        for _ in range(count):
            length = struct.unpack_from("<i", buf, offset)[0]
            offset += 4
            if length < 0:
                results.append(None)
            else:
                results.append(buf[offset:offset + length])
                offset += length
        return results

    @staticmethod
    def put(key: str, value: bytes):
        if _pymode is None:
            raise RuntimeError("KV requires PythonDO host imports (_pymode not available)")
        _pymode.kv_put(key, value)

    @staticmethod
    def multi_put(entries: list[tuple[str, bytes]]):
        """Put multiple key-value pairs in one Asyncify call."""
        import struct
        if _pymode is None:
            raise RuntimeError("KV requires PythonDO host imports (_pymode not available)")
        # Pack: [4B count][for each: [4B key_len][key][4B val_len][val]]
        parts = [struct.pack("<i", len(entries))]
        for key, val in entries:
            key_bytes = key.encode("utf-8")
            parts.append(struct.pack("<i", len(key_bytes)))
            parts.append(key_bytes)
            parts.append(struct.pack("<i", len(val)))
            parts.append(val)
        _pymode.kv_multi_put(b"".join(parts))

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

    @staticmethod
    def batch(queries: list[dict], binding_name: str = "D1") -> list[list[dict]]:
        """Execute multiple SQL statements in one Asyncify call (CF db.batch()).

        queries: list of {sql, params, binding} dicts.
        Returns list of result lists, one per query.
        """
        if _pymode is None:
            raise RuntimeError("D1 requires PythonDO host imports (_pymode not available)")
        queries_json = json.dumps(queries)
        result = _pymode.d1_batch(queries_json)
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
