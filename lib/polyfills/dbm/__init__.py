"""dbm polyfill for WASM — simple key-value database interface.
Uses an in-memory dict since there's no persistent filesystem.
"""

class error(OSError): pass

_databases = {}

def open(file, flag='r', mode=0o666):
    if file not in _databases:
        if flag in ('r',):
            raise error(f"need 'c' or 'n' flag to create database: {file!r}")
        _databases[file] = {}
    return _InMemoryDB(_databases[file])

def whichdb(filename):
    return None

class _InMemoryDB:
    def __init__(self, data):
        self._data = data

    def __getitem__(self, key):
        if isinstance(key, str):
            key = key.encode()
        val = self._data.get(key)
        if val is None:
            raise KeyError(key)
        return val

    def __setitem__(self, key, value):
        if isinstance(key, str):
            key = key.encode()
        if isinstance(value, str):
            value = value.encode()
        self._data[key] = value

    def __delitem__(self, key):
        if isinstance(key, str):
            key = key.encode()
        del self._data[key]

    def __contains__(self, key):
        if isinstance(key, str):
            key = key.encode()
        return key in self._data

    def __len__(self):
        return len(self._data)

    def __iter__(self):
        return iter(self._data)

    def keys(self):
        return self._data.keys()

    def values(self):
        return self._data.values()

    def items(self):
        return self._data.items()

    def get(self, key, default=None):
        if isinstance(key, str):
            key = key.encode()
        return self._data.get(key, default)

    def close(self):
        pass

    def sync(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
