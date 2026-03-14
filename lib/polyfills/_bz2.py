"""_bz2 polyfill for WASM — bz2 compression/decompression interface.
Provides the classes that bz2.py imports. Actual compression raises
RuntimeError since libbz2 is not compiled to WASM yet.
"""

class BZ2Compressor:
    def __init__(self, compresslevel=9):
        self._compresslevel = compresslevel

    def compress(self, data):
        raise RuntimeError("bz2 compression not yet compiled for WASM — use gzip/zlib instead")

    def flush(self):
        raise RuntimeError("bz2 compression not yet compiled for WASM — use gzip/zlib instead")

class BZ2Decompressor:
    def __init__(self):
        self.eof = False
        self.unused_data = b""
        self.needs_input = True

    def decompress(self, data, max_length=-1):
        raise RuntimeError("bz2 decompression not yet compiled for WASM — use gzip/zlib instead")
