"""mmap polyfill for WASM — memory-mapped file interface backed by bytearray."""

PROT_READ = 1
PROT_WRITE = 2
PROT_EXEC = 4
MAP_SHARED = 1
MAP_PRIVATE = 2
MAP_ANONYMOUS = 0x20
PAGESIZE = 65536
ACCESS_READ = 1
ACCESS_WRITE = 2
ACCESS_COPY = 3
ACCESS_DEFAULT = 0

class error(OSError): pass

class mmap:
    def __init__(self, fileno, length, tagname=None, access=ACCESS_WRITE, offset=0):
        if fileno != -1:
            raise error("file-backed mmap not supported — use fileno=-1 for anonymous mapping")
        self._data = bytearray(length)
        self._pos = 0
        self._closed = False

    def close(self):
        self._closed = True

    def __len__(self):
        return len(self._data)

    def __getitem__(self, key):
        return self._data[key]

    def __setitem__(self, key, value):
        self._data[key] = value

    def read(self, n=-1):
        if n == -1:
            n = len(self._data) - self._pos
        result = bytes(self._data[self._pos:self._pos + n])
        self._pos += len(result)
        return result

    def write(self, data):
        n = len(data)
        self._data[self._pos:self._pos + n] = data
        self._pos += n
        return n

    def seek(self, pos, whence=0):
        if whence == 0:
            self._pos = pos
        elif whence == 1:
            self._pos += pos
        elif whence == 2:
            self._pos = len(self._data) + pos

    def tell(self):
        return self._pos

    def size(self):
        return len(self._data)

    def find(self, sub, start=0, end=None):
        if end is None:
            end = len(self._data)
        return self._data.find(sub, start, end)

    def rfind(self, sub, start=0, end=None):
        if end is None:
            end = len(self._data)
        return self._data.rfind(sub, start, end)

    def flush(self, offset=0, size=0):
        pass

    def move(self, dest, src, count):
        self._data[dest:dest + count] = self._data[src:src + count]

    def resize(self, newsize):
        if newsize > len(self._data):
            self._data.extend(bytearray(newsize - len(self._data)))
        else:
            del self._data[newsize:]

    def readline(self):
        idx = self._data.find(b'\n', self._pos)
        if idx == -1:
            result = bytes(self._data[self._pos:])
            self._pos = len(self._data)
        else:
            result = bytes(self._data[self._pos:idx + 1])
            self._pos = idx + 1
        return result

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
