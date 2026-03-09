"""Pure Python binascii — replaces the C extension module.

Implements the subset of binascii used by base64.py, hashlib.py, and hmac.py.
Reference: metal0/packages/runtime/src/Lib/binascii.zig (pure Zig equivalent).

Functions:
    hexlify / b2a_hex     — bytes to hex string
    unhexlify / a2b_hex   — hex string to bytes
    b2a_base64            — bytes to base64
    a2b_base64            — base64 to bytes
    crc32                 — CRC-32 checksum
    Error                 — exception class
"""


class Error(ValueError):
    pass


class Incomplete(Exception):
    pass


# ── Hex ──────────────────────────────────────────────────────────

_HEX = b"0123456789abcdef"


def hexlify(data, sep=None, bytes_per_sep=1):
    if isinstance(data, memoryview):
        data = bytes(data)
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError(f"a bytes-like object is required, not '{type(data).__name__}'")
    result = bytearray(len(data) * 2)
    for i, b in enumerate(data):
        result[i * 2] = _HEX[b >> 4]
        result[i * 2 + 1] = _HEX[b & 0x0F]
    return bytes(result)


b2a_hex = hexlify


def unhexlify(hexstr):
    if isinstance(hexstr, memoryview):
        hexstr = bytes(hexstr)
    if isinstance(hexstr, str):
        hexstr = hexstr.encode("ascii")
    if len(hexstr) % 2 != 0:
        raise Error("Odd-length string")
    result = bytearray(len(hexstr) // 2)
    for i in range(0, len(hexstr), 2):
        hi = _hex_nibble(hexstr[i])
        lo = _hex_nibble(hexstr[i + 1])
        result[i // 2] = (hi << 4) | lo
    return bytes(result)


a2b_hex = unhexlify


def _hex_nibble(c):
    if 48 <= c <= 57:    # '0'-'9'
        return c - 48
    if 65 <= c <= 70:    # 'A'-'F'
        return c - 55
    if 97 <= c <= 102:   # 'a'-'f'
        return c - 87
    raise Error("Non-hexadecimal digit found")


# ── Base64 ───────────────────────────────────────────────────────

_B64_ENCODE = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
_B64_DECODE = [255] * 256
for _i, _c in enumerate(_B64_ENCODE):
    _B64_DECODE[_c] = _i
_B64_DECODE[ord("=")] = 0
_B64_PAD = ord("=")


def b2a_base64(data, *, newline=True):
    if isinstance(data, memoryview):
        data = bytes(data)
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError(f"a bytes-like object is required, not '{type(data).__name__}'")

    result = bytearray()
    for i in range(0, len(data), 3):
        chunk = data[i:i + 3]
        n = len(chunk)
        b0 = chunk[0]
        b1 = chunk[1] if n > 1 else 0
        b2 = chunk[2] if n > 2 else 0

        result.append(_B64_ENCODE[(b0 >> 2) & 0x3F])
        result.append(_B64_ENCODE[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)])
        if n > 1:
            result.append(_B64_ENCODE[((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)])
        else:
            result.append(_B64_PAD)
        if n > 2:
            result.append(_B64_ENCODE[b2 & 0x3F])
        else:
            result.append(_B64_PAD)

    if newline:
        result.append(ord("\n"))
    return bytes(result)


def a2b_base64(data, strict_mode=False):
    if isinstance(data, memoryview):
        data = bytes(data)
    if isinstance(data, str):
        data = data.encode("ascii")

    # Strip whitespace
    clean = bytearray()
    for c in data:
        if c in (32, 9, 10, 13):  # space, tab, newline, carriage return
            if strict_mode:
                raise Error("Invalid character in base64 data")
            continue
        clean.append(c)

    if len(clean) == 0:
        return b""

    # Validate length
    if len(clean) % 4 != 0:
        if strict_mode:
            raise Error("Invalid base64-encoded string")
        # Pad to multiple of 4
        clean.extend(b"=" * (4 - len(clean) % 4))

    result = bytearray()
    for i in range(0, len(clean), 4):
        c0 = _B64_DECODE[clean[i]]
        c1 = _B64_DECODE[clean[i + 1]]
        c2 = _B64_DECODE[clean[i + 2]]
        c3 = _B64_DECODE[clean[i + 3]]

        if c0 == 255 or c1 == 255 or c2 == 255 or c3 == 255:
            raise Error("Invalid base64-encoded string")

        result.append(((c0 << 2) | (c1 >> 4)) & 0xFF)
        if clean[i + 2] != _B64_PAD:
            result.append(((c1 << 4) | (c2 >> 2)) & 0xFF)
        if clean[i + 3] != _B64_PAD:
            result.append(((c2 << 6) | c3) & 0xFF)

    return bytes(result)


# ── CRC-32 ───────────────────────────────────────────────────────

_CRC32_TABLE = None


def _make_crc32_table():
    global _CRC32_TABLE
    if _CRC32_TABLE is not None:
        return
    _CRC32_TABLE = []
    for i in range(256):
        crc = i
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xEDB88320
            else:
                crc >>= 1
        _CRC32_TABLE.append(crc)


def crc32(data, value=0):
    if isinstance(data, memoryview):
        data = bytes(data)
    _make_crc32_table()
    crc = value ^ 0xFFFFFFFF
    for b in data:
        crc = _CRC32_TABLE[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF


# ── CRC-HQXX ────────────────────────────────────────────────────

def crc_hqx(data, value):
    crc = value
    for b in data:
        crc = ((crc << 8) & 0xFF00) ^ _CRC_HQXX_TABLE[((crc >> 8) ^ b) & 0xFF]
    return crc & 0xFFFF


_CRC_HQXX_TABLE = [
    0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50A5, 0x60C6, 0x70E7,
    0x8108, 0x9129, 0xA14A, 0xB16B, 0xC18C, 0xD1AD, 0xE1CE, 0xF1EF,
    0x1231, 0x0210, 0x3273, 0x2252, 0x52B5, 0x4294, 0x72F7, 0x62D6,
    0x9339, 0x8318, 0xB37B, 0xA35A, 0xD3BD, 0xC39C, 0xF3FF, 0xE3DE,
    0x2462, 0x3443, 0x0420, 0x1401, 0x64E6, 0x74C7, 0x44A4, 0x5485,
    0xA56A, 0xB54B, 0x8528, 0x9509, 0xE5EE, 0xF5CF, 0xC5AC, 0xD58D,
    0x3653, 0x2672, 0x1611, 0x0630, 0x76D7, 0x66F6, 0x5695, 0x46B4,
    0xB75B, 0xA77A, 0x9719, 0x8738, 0xF7DF, 0xE7FE, 0xD79D, 0xC7BC,
    0x4864, 0x5845, 0x6826, 0x7807, 0x08E0, 0x18C1, 0x28A2, 0x3883,
    0xC96C, 0xD94D, 0xE92E, 0xF90F, 0x89E8, 0x99C9, 0xA9AA, 0xB98B,
    0x5A55, 0x4A74, 0x7A17, 0x6A36, 0x1AD1, 0x0AF0, 0x3A93, 0x2AB2,
    0xDB5D, 0xCB7C, 0xFB1F, 0xEB3E, 0x9BD9, 0x8BF8, 0xBBA3, 0xAB82,
    0x6C36, 0x7C17, 0x4C74, 0x5C55, 0x2CB2, 0x3C93, 0x0CF0, 0x1CD1,
    0xED3E, 0xFD1F, 0xCD7C, 0xDD5D, 0xADBA, 0xBD9B, 0x8DF8, 0x9DD9,
    0x7E07, 0x6E26, 0x5E45, 0x4E64, 0x3E83, 0x2EA2, 0x1EC1, 0x0EE0,
    0xFF0F, 0xEF2E, 0xDF4D, 0xCF6C, 0xBF8B, 0xAF2A, 0x9F69, 0x8F48,
]


# ── UU encoding ──────────────────────────────────────────────────

def b2a_uu(data, *, backtick=False):
    if len(data) > 45:
        raise Error("At most 45 bytes at once")

    def enc(val):
        c = (val & 0x3F) + 32
        return 96 if backtick and c == 32 else c

    result = bytearray()
    result.append(enc(len(data)))
    for i in range(0, len(data), 3):
        b0 = data[i]
        b1 = data[i + 1] if i + 1 < len(data) else 0
        b2 = data[i + 2] if i + 2 < len(data) else 0
        result.append(enc((b0 >> 2) & 0x3F))
        result.append(enc(((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)))
        result.append(enc(((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)))
        result.append(enc(b2 & 0x3F))
    result.append(ord("\n"))
    return bytes(result)


def a2b_uu(data):
    if isinstance(data, str):
        data = data.encode("ascii")
    if len(data) == 0:
        return b""
    length = (data[0] - 32) & 0x3F
    result = bytearray()
    i = 1
    while len(result) < length and i + 3 < len(data):
        c0 = (data[i] - 32) & 0x3F
        c1 = (data[i + 1] - 32) & 0x3F
        c2 = (data[i + 2] - 32) & 0x3F
        c3 = (data[i + 3] - 32) & 0x3F
        result.append((c0 << 2) | (c1 >> 4))
        result.append(((c1 << 4) | (c2 >> 2)) & 0xFF)
        result.append(((c2 << 6) | c3) & 0xFF)
        i += 4
    return bytes(result[:length])
