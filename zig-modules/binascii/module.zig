// Zig replacement for CPython's Modules/binascii.c
// Implements hex, base64, CRC32, UU encoding using native Zig — zero interpreter overhead.
//
// This module exports PyInit_binascii so CPython loads it as a built-in extension,
// replacing the pure Python polyfill in lib/polyfills/binascii.py.

const std = @import("std");
const c = @cImport({
    @cInclude("Python.h");
});

// ============================================================================
// CRC32 TABLE (IEEE polynomial 0xEDB88320)
// ============================================================================

const crc32_table: [256]u32 = blk: {
    var table: [256]u32 = undefined;
    for (0..256) |i| {
        var crc: u32 = @intCast(i);
        for (0..8) |_| {
            if (crc & 1 != 0) {
                crc = (crc >> 1) ^ 0xEDB88320;
            } else {
                crc >>= 1;
            }
        }
        table[i] = crc;
    }
    break :blk table;
};

// ============================================================================
// CRC-HQXX TABLE
// ============================================================================

const crc_hqx_table: [256]u16 = blk: {
    var table: [256]u16 = undefined;
    for (0..256) |i| {
        var crc: u16 = @as(u16, @intCast(i)) << 8;
        for (0..8) |_| {
            if (crc & 0x8000 != 0) {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
        table[i] = crc;
    }
    break :blk table;
};

// ============================================================================
// HEX
// ============================================================================

const hex_chars = "0123456789abcdef";

fn py_hexlify(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var view: c.Py_buffer = undefined;
    if (c.PyArg_ParseTuple(args, "y*", &view) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const data: [*]const u8 = @ptrCast(view.buf);
    const len: usize = @intCast(view.len);

    const result = c.PyBytes_FromStringAndSize(null, @intCast(len * 2));
    if (result == null) return null;
    const out: [*]u8 = @ptrCast(c.PyBytes_AsString(result));

    for (0..len) |i| {
        out[i * 2] = hex_chars[data[i] >> 4];
        out[i * 2 + 1] = hex_chars[data[i] & 0x0f];
    }

    return result;
}

fn hex_nibble(ch: u8) ?u8 {
    if (ch >= '0' and ch <= '9') return ch - '0';
    if (ch >= 'A' and ch <= 'F') return ch - 'A' + 10;
    if (ch >= 'a' and ch <= 'f') return ch - 'a' + 10;
    return null;
}

fn py_unhexlify(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var data_ptr: [*]const u8 = undefined;
    var data_len: c.Py_ssize_t = 0;
    if (c.PyArg_ParseTuple(args, "s#", &data_ptr, &data_len) == 0) return null;

    const len: usize = @intCast(data_len);
    if (len % 2 != 0) {
        c.PyErr_SetString(c.PyExc_ValueError, "Odd-length string");
        return null;
    }

    const result = c.PyBytes_FromStringAndSize(null, @intCast(len / 2));
    if (result == null) return null;
    const out: [*]u8 = @ptrCast(c.PyBytes_AsString(result));

    var i: usize = 0;
    while (i < len) : (i += 2) {
        const hi = hex_nibble(data_ptr[i]) orelse {
            c.Py_DecRef(result);
            c.PyErr_SetString(c.PyExc_ValueError, "Non-hexadecimal digit found");
            return null;
        };
        const lo = hex_nibble(data_ptr[i + 1]) orelse {
            c.Py_DecRef(result);
            c.PyErr_SetString(c.PyExc_ValueError, "Non-hexadecimal digit found");
            return null;
        };
        out[i / 2] = (hi << 4) | lo;
    }

    return result;
}

// ============================================================================
// BASE64
// ============================================================================

const b64_encode = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const b64_decode: [256]u8 = blk: {
    var table: [256]u8 = .{0xFF} ** 256;
    for (b64_encode, 0..) |ch, i| {
        table[ch] = @intCast(i);
    }
    table['='] = 0;
    break :blk table;
};

fn py_b2a_base64(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var view: c.Py_buffer = undefined;
    var newline: c_int = 1;

    var kwlist = [_:null]?[*:0]const u8{ "data", "newline", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "y*|$p", @ptrCast(&kwlist), &view, &newline) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const data: [*]const u8 = @ptrCast(view.buf);
    const len: usize = @intCast(view.len);

    // Output size: ceil(len/3)*4 + optional newline
    const out_len = ((len + 2) / 3) * 4 + @as(usize, if (newline != 0) 1 else 0);
    const result = c.PyBytes_FromStringAndSize(null, @intCast(out_len));
    if (result == null) return null;
    const out: [*]u8 = @ptrCast(c.PyBytes_AsString(result));

    var oi: usize = 0;
    var i: usize = 0;
    while (i < len) {
        const b0 = data[i];
        const b1: u8 = if (i + 1 < len) data[i + 1] else 0;
        const b2: u8 = if (i + 2 < len) data[i + 2] else 0;
        const remaining = len - i;

        out[oi] = b64_encode[(b0 >> 2) & 0x3F];
        out[oi + 1] = b64_encode[((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F)];
        out[oi + 2] = if (remaining > 1) b64_encode[((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03)] else '=';
        out[oi + 3] = if (remaining > 2) b64_encode[b2 & 0x3F] else '=';

        oi += 4;
        i += 3;
    }

    if (newline != 0) {
        out[oi] = '\n';
    }

    return result;
}

fn py_a2b_base64(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var data_ptr: [*]const u8 = undefined;
    var data_len: c.Py_ssize_t = 0;
    var strict_mode: c_int = 0;

    var kwlist = [_:null]?[*:0]const u8{ "data", "strict_mode", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "s#|$p", @ptrCast(&kwlist), &data_ptr, &data_len, &strict_mode) == 0) return null;

    const data = data_ptr;
    const len: usize = @intCast(data_len);

    // Strip whitespace and collect clean input
    var clean_buf: [*]u8 = undefined;
    var clean_len: usize = 0;
    // Allocate worst case
    const tmp = c.PyMem_Malloc(len + 4);
    if (tmp == null) {
        c.PyErr_SetString(c.PyExc_MemoryError, "out of memory");
        return null;
    }
    clean_buf = @ptrCast(tmp);
    defer c.PyMem_Free(tmp);

    for (0..len) |i| {
        const ch = data[i];
        if (ch == ' ' or ch == '\t' or ch == '\n' or ch == '\r') {
            if (strict_mode != 0) {
                c.PyErr_SetString(c.PyExc_ValueError, "Invalid character in base64 data");
                return null;
            }
            continue;
        }
        clean_buf[clean_len] = ch;
        clean_len += 1;
    }

    if (clean_len == 0) {
        return c.PyBytes_FromStringAndSize(null, 0);
    }

    // Pad to multiple of 4
    while (clean_len % 4 != 0) {
        clean_buf[clean_len] = '=';
        clean_len += 1;
    }

    // Decode into temporary buffer then create PyBytes with exact size
    const out_max = (clean_len / 4) * 3;
    const out_tmp = c.PyMem_Malloc(out_max);
    if (out_tmp == null) {
        c.PyErr_SetString(c.PyExc_MemoryError, "out of memory");
        return null;
    }
    const out: [*]u8 = @ptrCast(out_tmp);
    defer c.PyMem_Free(out_tmp);
    var oi: usize = 0;

    var i: usize = 0;
    while (i + 3 < clean_len) : (i += 4) {
        const c0 = b64_decode[clean_buf[i]];
        const c1 = b64_decode[clean_buf[i + 1]];
        const c2 = b64_decode[clean_buf[i + 2]];
        const c3 = b64_decode[clean_buf[i + 3]];

        if (c0 == 0xFF or c1 == 0xFF or c2 == 0xFF or c3 == 0xFF) {
            c.PyErr_SetString(c.PyExc_ValueError, "Invalid base64-encoded string");
            return null;
        }

        out[oi] = (c0 << 2) | (c1 >> 4);
        oi += 1;
        if (clean_buf[i + 2] != '=') {
            out[oi] = ((c1 << 4) | (c2 >> 2)) & 0xFF;
            oi += 1;
        }
        if (clean_buf[i + 3] != '=') {
            out[oi] = ((c2 << 6) | c3) & 0xFF;
            oi += 1;
        }
    }

    return c.PyBytes_FromStringAndSize(@ptrCast(out), @intCast(oi));
}

// ============================================================================
// CRC32
// ============================================================================

fn py_crc32(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var view: c.Py_buffer = undefined;
    var init_val: c_uint = 0;
    if (c.PyArg_ParseTuple(args, "y*|I", &view, &init_val) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const data: [*]const u8 = @ptrCast(view.buf);
    const len: usize = @intCast(view.len);

    var crc: u32 = init_val ^ 0xFFFFFFFF;
    for (0..len) |i| {
        crc = crc32_table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
    }

    return c.PyLong_FromUnsignedLong((crc ^ 0xFFFFFFFF) & 0xFFFFFFFF);
}

// ============================================================================
// CRC-HQXX
// ============================================================================

fn py_crc_hqx(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var view: c.Py_buffer = undefined;
    var init_val: c_uint = 0;
    if (c.PyArg_ParseTuple(args, "y*I", &view, &init_val) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const data: [*]const u8 = @ptrCast(view.buf);
    const len: usize = @intCast(view.len);

    var crc: u16 = @intCast(init_val & 0xFFFF);
    for (0..len) |i| {
        crc = (crc << 8) ^ crc_hqx_table[((crc >> 8) ^ data[i]) & 0xFF];
    }

    return c.PyLong_FromUnsignedLong(crc);
}

// ============================================================================
// UU ENCODING
// ============================================================================

fn uu_enc(val: u8, backtick: bool) u8 {
    const ch = (val & 0x3F) + 32;
    return if (backtick and ch == 32) 96 else ch;
}

fn py_b2a_uu(_: ?*c.PyObject, args: ?*c.PyObject, kwargs: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var view: c.Py_buffer = undefined;
    var backtick: c_int = 0;

    var kwlist = [_:null]?[*:0]const u8{ "data", "backtick", null };
    if (c.PyArg_ParseTupleAndKeywords(args, kwargs, "y*|$p", @ptrCast(&kwlist), &view, &backtick) == 0) return null;
    defer c.PyBuffer_Release(&view);

    const data: [*]const u8 = @ptrCast(view.buf);
    const len: usize = @intCast(view.len);

    if (len > 45) {
        c.PyErr_SetString(c.PyExc_ValueError, "At most 45 bytes at once");
        return null;
    }

    const bt = backtick != 0;
    // Output: 1 (length) + ceil(len/3)*4 + 1 (newline)
    const out_len = 1 + ((len + 2) / 3) * 4 + 1;
    const result = c.PyBytes_FromStringAndSize(null, @intCast(out_len));
    if (result == null) return null;
    const out: [*]u8 = @ptrCast(c.PyBytes_AsString(result));

    out[0] = uu_enc(@intCast(len), bt);
    var oi: usize = 1;
    var i: usize = 0;
    while (i < len) : (i += 3) {
        const b0 = data[i];
        const b1: u8 = if (i + 1 < len) data[i + 1] else 0;
        const b2: u8 = if (i + 2 < len) data[i + 2] else 0;
        out[oi] = uu_enc((b0 >> 2) & 0x3F, bt);
        out[oi + 1] = uu_enc(((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0F), bt);
        out[oi + 2] = uu_enc(((b1 & 0x0F) << 2) | ((b2 >> 6) & 0x03), bt);
        out[oi + 3] = uu_enc(b2 & 0x3F, bt);
        oi += 4;
    }
    out[oi] = '\n';

    return result;
}

fn py_a2b_uu(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.c) ?*c.PyObject {
    var data_ptr: [*]const u8 = undefined;
    var data_len: c.Py_ssize_t = 0;
    if (c.PyArg_ParseTuple(args, "s#", &data_ptr, &data_len) == 0) return null;

    const len: usize = @intCast(data_len);
    if (len == 0) return c.PyBytes_FromStringAndSize(null, 0);

    const expected: usize = (data_ptr[0] -% 32) & 0x3F;
    const result = c.PyBytes_FromStringAndSize(null, @intCast(expected));
    if (result == null) return null;
    const out: [*]u8 = @ptrCast(c.PyBytes_AsString(result));

    var oi: usize = 0;
    var i: usize = 1;
    while (oi < expected and i + 3 < len) {
        const c0 = (data_ptr[i] -% 32) & 0x3F;
        const c1 = (data_ptr[i + 1] -% 32) & 0x3F;
        const c2 = (data_ptr[i + 2] -% 32) & 0x3F;
        const c3 = (data_ptr[i + 3] -% 32) & 0x3F;
        if (oi < expected) {
            out[oi] = (c0 << 2) | (c1 >> 4);
            oi += 1;
        }
        if (oi < expected) {
            out[oi] = ((c1 << 4) | (c2 >> 2)) & 0xFF;
            oi += 1;
        }
        if (oi < expected) {
            out[oi] = ((c2 << 6) | c3) & 0xFF;
            oi += 1;
        }
        i += 4;
    }

    return result;
}

// ============================================================================
// MODULE DEFINITION
// ============================================================================

var error_type: ?*c.PyObject = null;
var incomplete_type: ?*c.PyObject = null;

const module_methods = [_]c.PyMethodDef{
    .{
        .ml_name = "hexlify",
        .ml_meth = @ptrCast(&py_hexlify),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Hexadecimal representation of binary data.",
    },
    .{
        .ml_name = "b2a_hex",
        .ml_meth = @ptrCast(&py_hexlify),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Hexadecimal representation of binary data.",
    },
    .{
        .ml_name = "unhexlify",
        .ml_meth = @ptrCast(&py_unhexlify),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Binary data of hexadecimal representation.",
    },
    .{
        .ml_name = "a2b_hex",
        .ml_meth = @ptrCast(&py_unhexlify),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Binary data of hexadecimal representation.",
    },
    .{
        .ml_name = "b2a_base64",
        .ml_meth = @ptrCast(&py_b2a_base64),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Base64-code line of data.",
    },
    .{
        .ml_name = "a2b_base64",
        .ml_meth = @ptrCast(&py_a2b_base64),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Decode a line of base64 data.",
    },
    .{
        .ml_name = "crc32",
        .ml_meth = @ptrCast(&py_crc32),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Compute CRC-32 incrementally.",
    },
    .{
        .ml_name = "crc_hqx",
        .ml_meth = @ptrCast(&py_crc_hqx),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Compute CRC-CCITT incrementally.",
    },
    .{
        .ml_name = "b2a_uu",
        .ml_meth = @ptrCast(&py_b2a_uu),
        .ml_flags = c.METH_VARARGS | c.METH_KEYWORDS,
        .ml_doc = "Uuencode line of data.",
    },
    .{
        .ml_name = "a2b_uu",
        .ml_meth = @ptrCast(&py_a2b_uu),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "Decode a line of uuencoded data.",
    },
    // Sentinel
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var module_def = c.PyModuleDef{
    .m_base = std.mem.zeroes(c.PyModuleDef_Base),
    .m_name = "binascii",
    .m_doc = "Conversion between binary data and ASCII — Zig native implementation",
    .m_size = -1,
    .m_methods = @constCast(&module_methods),
    .m_slots = null,
    .m_traverse = null,
    .m_clear = null,
    .m_free = null,
};

export fn PyInit_binascii() ?*c.PyObject {
    const module = c.PyModule_Create(&module_def);
    if (module == null) return null;

    // Create Error exception (subclass of ValueError)
    error_type = c.PyErr_NewException("binascii.Error", c.PyExc_ValueError, null);
    if (error_type) |et| {
        c.Py_IncRef(et);
        _ = c.PyModule_AddObject(module, "Error", et);
    }

    // Create Incomplete exception
    incomplete_type = c.PyErr_NewException("binascii.Incomplete", c.PyExc_Exception, null);
    if (incomplete_type) |it| {
        c.Py_IncRef(it);
        _ = c.PyModule_AddObject(module, "Incomplete", it);
    }

    return module;
}
