"""_lzma polyfill for WASM — lzma/xz compression interface.
Provides the constants and classes that lzma.py imports. Actual compression raises
LZMAError since liblzma is not compiled to WASM yet.
"""

FORMAT_AUTO = 0
FORMAT_XZ = 1
FORMAT_ALONE = 2
FORMAT_RAW = 3
CHECK_NONE = 0
CHECK_CRC32 = 1
CHECK_CRC64 = 4
CHECK_SHA256 = 10
CHECK_UNKNOWN = 16
MF_HC3 = 0x03
MF_HC4 = 0x04
MF_BT2 = 0x12
MF_BT3 = 0x13
MF_BT4 = 0x14
MODE_FAST = 1
MODE_NORMAL = 2
PRESET_DEFAULT = 6
PRESET_EXTREME = (1 << 31)

class LZMAError(Exception):
    pass

class LZMACompressor:
    def __init__(self, format=FORMAT_XZ, check=-1, preset=None, filters=None):
        pass

    def compress(self, data):
        raise LZMAError("lzma compression not yet compiled for WASM — use gzip/zlib instead")

    def flush(self):
        raise LZMAError("lzma compression not yet compiled for WASM — use gzip/zlib instead")

class LZMADecompressor:
    def __init__(self, format=FORMAT_AUTO, memlimit=None, filters=None):
        self.eof = False
        self.unused_data = b""
        self.needs_input = True
        self.check = CHECK_UNKNOWN

    def decompress(self, data, max_length=-1):
        raise LZMAError("lzma decompression not yet compiled for WASM — use gzip/zlib instead")

def is_check_supported(check):
    return False

def _encode_filter_properties(filter):
    raise LZMAError("lzma filter encoding not available in WASM")

def _decode_filter_properties(filter_id, encoded_props):
    raise LZMAError("lzma filter decoding not available in WASM")
