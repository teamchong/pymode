"""Pure-Python zlib — replaces the C extension module.

Implements zlib compression/decompression for CF Workers where the native
zlib C extension is not linked into python.wasm.

Compression uses stored blocks (valid DEFLATE, not size-optimal).
Decompression handles all three DEFLATE block types (stored, fixed Huffman,
dynamic Huffman) per RFC 1950/1951.

Reference: metal0/packages/runtime/src/Lib/compression/zlib.zig (Zig equivalent).
"""

import struct as _struct

# ── Exception ────────────────────────────────────────────────────

class error(Exception):
    pass

# ── Constants ────────────────────────────────────────────────────

MAX_WBITS = 15
DEF_MEM_LEVEL = 8
DEF_BUF_SIZE = 16384
DEFLATED = 8

Z_NO_COMPRESSION = 0
Z_BEST_SPEED = 1
Z_BEST_COMPRESSION = 9
Z_DEFAULT_COMPRESSION = -1

Z_FILTERED = 1
Z_HUFFMAN_ONLY = 2
Z_RLE = 3
Z_FIXED = 4
Z_DEFAULT_STRATEGY = 0

Z_NO_FLUSH = 0
Z_PARTIAL_FLUSH = 1
Z_SYNC_FLUSH = 2
Z_FULL_FLUSH = 3
Z_FINISH = 4
Z_BLOCK = 5
Z_TREES = 6

ZLIB_VERSION = "1.2.13"
ZLIB_RUNTIME_VERSION = "1.2.13"


# ── Checksums ────────────────────────────────────────────────────

from binascii import crc32


def adler32(data, value=1):
    if isinstance(data, memoryview):
        data = bytes(data)
    a = value & 0xFFFF
    b = (value >> 16) & 0xFFFF
    for byte in data:
        a = (a + byte) % 65521
        b = (b + a) % 65521
    return ((b << 16) | a) & 0xFFFFFFFF


# ── DEFLATE Decompression (RFC 1951) ─────────────────────────────

class _BitReader:
    __slots__ = ("data", "pos", "bit_buf", "bit_cnt")

    def __init__(self, data):
        self.data = data
        self.pos = 0
        self.bit_buf = 0
        self.bit_cnt = 0

    def _fill(self, n):
        while self.bit_cnt < n:
            if self.pos >= len(self.data):
                raise error("unexpected end of input")
            self.bit_buf |= self.data[self.pos] << self.bit_cnt
            self.pos += 1
            self.bit_cnt += 8

    def bits(self, n):
        self._fill(n)
        val = self.bit_buf & ((1 << n) - 1)
        self.bit_buf >>= n
        self.bit_cnt -= n
        return val

    def align(self):
        skip = self.bit_cnt % 8
        if skip:
            self.bit_buf >>= skip
            self.bit_cnt -= skip

    def read_bytes(self, n):
        self.align()
        # Drain bit buffer first
        out = bytearray()
        while n > 0 and self.bit_cnt >= 8:
            out.append(self.bit_buf & 0xFF)
            self.bit_buf >>= 8
            self.bit_cnt -= 8
            n -= 1
        if n > 0:
            if self.pos + n > len(self.data):
                raise error("unexpected end of input")
            out.extend(self.data[self.pos:self.pos + n])
            self.pos += n
        return bytes(out)


# Fixed Huffman tables (RFC 1951 section 3.2.6)
_FIXED_LIT = None
_FIXED_DIST = None

def _build_huffman(lengths):
    """Build decode table: maps (code, bit_length) -> symbol."""
    max_bits = max(lengths) if lengths else 0
    if max_bits == 0:
        return {}
    bl_count = [0] * (max_bits + 1)
    for l in lengths:
        if l > 0:
            bl_count[l] += 1
    code = 0
    next_code = [0] * (max_bits + 1)
    for bits in range(1, max_bits + 1):
        code = (code + bl_count[bits - 1]) << 1
        next_code[bits] = code
    table = {}
    for sym, l in enumerate(lengths):
        if l > 0:
            table[(next_code[l], l)] = sym
            next_code[l] += 1
    return table


def _decode_symbol(reader, table):
    code = 0
    for length in range(1, 16):
        code = (code << 1) | reader.bits(1)
        sym = table.get((code, length))
        if sym is not None:
            return sym
    raise error("invalid Huffman code")


def _get_fixed_tables():
    global _FIXED_LIT, _FIXED_DIST
    if _FIXED_LIT is not None:
        return _FIXED_LIT, _FIXED_DIST
    lit_lengths = []
    for i in range(288):
        if i < 144:
            lit_lengths.append(8)
        elif i < 256:
            lit_lengths.append(9)
        elif i < 280:
            lit_lengths.append(7)
        else:
            lit_lengths.append(8)
    dist_lengths = [5] * 32
    _FIXED_LIT = _build_huffman(lit_lengths)
    _FIXED_DIST = _build_huffman(dist_lengths)
    return _FIXED_LIT, _FIXED_DIST


# Length and distance extra bits tables (RFC 1951 section 3.2.5)
_LEN_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
]
_LEN_EXTRA = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
]
_DIST_BASE = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
    8193, 12289, 16385, 24577
]
_DIST_EXTRA = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
]
_CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]


def _inflate(reader):
    """Decompress raw DEFLATE stream."""
    output = bytearray()
    while True:
        bfinal = reader.bits(1)
        btype = reader.bits(2)

        if btype == 0:
            # Stored block
            reader.align()
            raw = reader.read_bytes(4)
            length = raw[0] | (raw[1] << 8)
            nlength = raw[2] | (raw[3] << 8)
            if length != (~nlength & 0xFFFF):
                raise error("invalid stored block lengths")
            output.extend(reader.read_bytes(length))

        elif btype == 1:
            # Fixed Huffman
            lit_table, dist_table = _get_fixed_tables()
            _inflate_block(reader, lit_table, dist_table, output)

        elif btype == 2:
            # Dynamic Huffman
            hlit = reader.bits(5) + 257
            hdist = reader.bits(5) + 1
            hclen = reader.bits(4) + 4
            cl_lengths = [0] * 19
            for i in range(hclen):
                cl_lengths[_CL_ORDER[i]] = reader.bits(3)
            cl_table = _build_huffman(cl_lengths)

            def read_lengths(count):
                lengths = []
                while len(lengths) < count:
                    sym = _decode_symbol(reader, cl_table)
                    if sym < 16:
                        lengths.append(sym)
                    elif sym == 16:
                        repeat = reader.bits(2) + 3
                        if not lengths:
                            raise error("invalid code lengths")
                        lengths.extend([lengths[-1]] * repeat)
                    elif sym == 17:
                        repeat = reader.bits(3) + 3
                        lengths.extend([0] * repeat)
                    elif sym == 18:
                        repeat = reader.bits(7) + 11
                        lengths.extend([0] * repeat)
                return lengths[:count]

            all_lengths = read_lengths(hlit + hdist)
            lit_table = _build_huffman(all_lengths[:hlit])
            dist_table = _build_huffman(all_lengths[hlit:])
            _inflate_block(reader, lit_table, dist_table, output)

        else:
            raise error("invalid block type")

        if bfinal:
            break

    return bytes(output)


def _inflate_block(reader, lit_table, dist_table, output):
    """Decode a single Huffman-coded DEFLATE block."""
    while True:
        sym = _decode_symbol(reader, lit_table)
        if sym < 256:
            output.append(sym)
        elif sym == 256:
            break
        else:
            # Length-distance pair
            idx = sym - 257
            if idx >= len(_LEN_BASE):
                raise error("invalid length code")
            length = _LEN_BASE[idx] + reader.bits(_LEN_EXTRA[idx])
            dist_sym = _decode_symbol(reader, dist_table)
            if dist_sym >= len(_DIST_BASE):
                raise error("invalid distance code")
            distance = _DIST_BASE[dist_sym] + reader.bits(_DIST_EXTRA[dist_sym])
            # Copy from output buffer (may overlap)
            start = len(output) - distance
            if start < 0:
                raise error("invalid distance")
            for i in range(length):
                output.append(output[start + i])


# ── DEFLATE Compression (stored blocks) ──────────────────────────

def _deflate(data):
    """Compress data using DEFLATE stored blocks (type 0).

    Valid per RFC 1951 — produces correct but uncompressed DEFLATE.
    Production builds use real zlib via C extension for optimal compression.
    """
    out = bytearray()
    offset = 0
    remaining = len(data)
    while remaining > 0:
        chunk = min(remaining, 65535)
        is_last = (remaining - chunk) == 0
        out.append(1 if is_last else 0)  # BFINAL + BTYPE=00
        out.extend(_struct.pack("<HH", chunk, chunk ^ 0xFFFF))
        out.extend(data[offset:offset + chunk])
        offset += chunk
        remaining -= chunk
    if len(data) == 0:
        out.append(1)  # BFINAL=1, BTYPE=00
        out.extend(_struct.pack("<HH", 0, 0xFFFF))
    return bytes(out)


# ── Public API ───────────────────────────────────────────────────

def compress(data, level=-1, wbits=MAX_WBITS):
    if isinstance(data, memoryview):
        data = bytes(data)
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("a bytes-like object is required")
    raw = _deflate(data)
    if wbits < 0:
        # Raw DEFLATE (no header/trailer)
        return raw
    elif wbits > 15:
        # Gzip wrapper
        return _gzip_wrap(data, raw)
    else:
        # Zlib wrapper (default)
        return _zlib_wrap(data, raw)


def _zlib_wrap(data, raw):
    """Wrap raw DEFLATE in zlib format (RFC 1950)."""
    cm = 8  # deflate
    cinfo = 7  # 32K window
    cmf = (cinfo << 4) | cm
    fcheck = (31 - ((cmf * 256) % 31)) % 31
    flg = fcheck
    header = bytes([cmf, flg])
    checksum = _struct.pack(">I", adler32(data))
    return header + raw + checksum


def _gzip_wrap(data, raw):
    """Wrap raw DEFLATE in gzip format (RFC 1952)."""
    header = b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff"
    checksum = _struct.pack("<I", crc32(data))
    size = _struct.pack("<I", len(data) & 0xFFFFFFFF)
    return header + raw + checksum + size


def decompress(data, wbits=MAX_WBITS, bufsize=DEF_BUF_SIZE):
    if isinstance(data, memoryview):
        data = bytes(data)
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("a bytes-like object is required")
    if len(data) == 0:
        raise error("incomplete or truncated stream")
    if wbits < 0:
        # Raw DEFLATE
        reader = _BitReader(data)
        return _inflate(reader)
    elif wbits > 15:
        # Gzip
        return _gzip_decompress(data)
    else:
        # Zlib
        return _zlib_decompress(data)


def _zlib_decompress(data):
    if len(data) < 6:
        raise error("incomplete zlib stream")
    cmf = data[0]
    flg = data[1]
    if (cmf * 256 + flg) % 31 != 0:
        raise error("invalid zlib header")
    cm = cmf & 0x0F
    if cm != 8:
        raise error("unsupported compression method")
    fdict = (flg >> 5) & 1
    offset = 2
    if fdict:
        offset += 4
    reader = _BitReader(data[offset:-4])
    result = _inflate(reader)
    stored_checksum = _struct.unpack(">I", data[-4:])[0]
    if adler32(result) != stored_checksum:
        raise error("invalid checksum")
    return result


def _gzip_decompress(data):
    if len(data) < 10:
        raise error("incomplete gzip stream")
    if data[0] != 0x1F or data[1] != 0x8B:
        raise error("not a gzip file")
    method = data[2]
    if method != 8:
        raise error("unsupported compression method")
    flags = data[3]
    offset = 10
    if flags & 0x04:  # FEXTRA
        xlen = data[offset] | (data[offset + 1] << 8)
        offset += 2 + xlen
    if flags & 0x08:  # FNAME
        while offset < len(data) and data[offset] != 0:
            offset += 1
        offset += 1
    if flags & 0x10:  # FCOMMENT
        while offset < len(data) and data[offset] != 0:
            offset += 1
        offset += 1
    if flags & 0x02:  # FHCRC
        offset += 2
    trailer = data[-8:]
    reader = _BitReader(data[offset:-8])
    result = _inflate(reader)
    stored_crc = _struct.unpack("<I", trailer[:4])[0]
    stored_size = _struct.unpack("<I", trailer[4:])[0]
    if crc32(result) != stored_crc:
        raise error("invalid CRC")
    if (len(result) & 0xFFFFFFFF) != stored_size:
        raise error("invalid size")
    return result


# ── Streaming objects ────────────────────────────────────────────

class _CompressObj:
    def __init__(self, level, method, wbits, memlevel, strategy):
        self._wbits = wbits
        self._chunks = []

    def compress(self, data):
        if isinstance(data, memoryview):
            data = bytes(data)
        self._chunks.append(data)
        return b""

    def flush(self, mode=Z_FINISH):
        data = b"".join(self._chunks)
        self._chunks = []
        return compress(data, wbits=self._wbits)

    def copy(self):
        obj = _CompressObj(0, DEFLATED, self._wbits, DEF_MEM_LEVEL, Z_DEFAULT_STRATEGY)
        obj._chunks = list(self._chunks)
        return obj


class _DecompressObj:
    def __init__(self, wbits):
        self._wbits = wbits
        self._chunks = []
        self.unused_data = b""
        self.unconsumed_tail = b""
        self.eof = False

    def decompress(self, data, max_length=0):
        if isinstance(data, memoryview):
            data = bytes(data)
        self._chunks.append(data)
        try:
            all_data = b"".join(self._chunks)
            result = decompress(all_data, wbits=self._wbits)
            self._chunks = []
            self.eof = True
            if max_length > 0 and len(result) > max_length:
                self.unconsumed_tail = result[max_length:]
                return result[:max_length]
            return result
        except error:
            # May need more data
            return b""

    def flush(self, length=DEF_BUF_SIZE):
        if self.unconsumed_tail:
            result = self.unconsumed_tail[:length]
            self.unconsumed_tail = self.unconsumed_tail[length:]
            return result
        if self._chunks:
            try:
                all_data = b"".join(self._chunks)
                result = decompress(all_data, wbits=self._wbits)
                self._chunks = []
                self.eof = True
                return result
            except error:
                return b""
        return b""

    def copy(self):
        obj = _DecompressObj(self._wbits)
        obj._chunks = list(self._chunks)
        obj.unused_data = self.unused_data
        obj.unconsumed_tail = self.unconsumed_tail
        obj.eof = self.eof
        return obj


def compressobj(level=Z_DEFAULT_COMPRESSION, method=DEFLATED, wbits=MAX_WBITS,
                memlevel=DEF_MEM_LEVEL, strategy=Z_DEFAULT_STRATEGY, zdict=None):
    return _CompressObj(level, method, wbits, memlevel, strategy)


def decompressobj(wbits=MAX_WBITS, zdict=None):
    return _DecompressObj(wbits)
