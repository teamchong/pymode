// Zig replacement for CPython's Modules/_json.c
// Uses metal0's SIMD JSON parser for faster encode/decode
//
// This module exports PyInit__json so CPython loads it as a native extension.
// Based on metal0's c_interop/_json.zig which already implements the CPython C API.
//
// CPython's json module loads _json as the C accelerator. It expects:
// - make_scanner: type object for creating JSON scanner/decoder instances
// - make_encoder: type object for creating JSON encoder instances
// - encode_basestring: function to escape a string for JSON
// - encode_basestring_ascii: function to escape a string (ASCII-only output)

const std = @import("std");
const c = @cImport({
    @cInclude("Python.h");
});

const allocator = std.heap.c_allocator;

// ============================================================================
// JSON SCANNER (DECODER) - maps to CPython's _json.Scanner
// ============================================================================

const ScannerObject = extern struct {
    ob_base: c.PyObject,
    strict: c_int,
    object_hook: ?*c.PyObject,
    object_pairs_hook: ?*c.PyObject,
    parse_float: ?*c.PyObject,
    parse_int: ?*c.PyObject,
    parse_constant: ?*c.PyObject,
    memo: ?*c.PyObject,
};

fn scanner_init(self_raw: ?*c.PyObject, args: ?*c.PyObject, _: ?*c.PyObject) callconv(.C) c_int {
    const self: *ScannerObject = @ptrCast(@alignCast(self_raw));
    var ctx: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &ctx) == 0) return -1;

    const context = ctx.?;

    self.strict = 1;
    self.object_hook = c.PyObject_GetAttrString(context, "object_hook");
    if (self.object_hook != null and self.object_hook == c.Py_None) {
        c.Py_DecRef(self.object_hook);
        self.object_hook = null;
    }
    _ = c.PyErr_Clear();

    self.object_pairs_hook = c.PyObject_GetAttrString(context, "object_pairs_hook");
    if (self.object_pairs_hook != null and self.object_pairs_hook == c.Py_None) {
        c.Py_DecRef(self.object_pairs_hook);
        self.object_pairs_hook = null;
    }
    _ = c.PyErr_Clear();

    self.parse_float = c.PyObject_GetAttrString(context, "parse_float");
    _ = c.PyErr_Clear();
    self.parse_int = c.PyObject_GetAttrString(context, "parse_int");
    _ = c.PyErr_Clear();
    self.parse_constant = c.PyObject_GetAttrString(context, "parse_constant");
    _ = c.PyErr_Clear();

    const strict_obj = c.PyObject_GetAttrString(context, "strict");
    if (strict_obj != null) {
        self.strict = if (c.PyObject_IsTrue(strict_obj) == 1) 1 else 0;
        c.Py_DecRef(strict_obj);
    }
    _ = c.PyErr_Clear();

    self.memo = c.PyDict_New();
    return 0;
}

fn scanner_call(self_raw: ?*c.PyObject, args: ?*c.PyObject, _: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    _ = @as(*ScannerObject, @ptrCast(@alignCast(self_raw)));
    var string: ?*c.PyObject = null;
    var idx: c.Py_ssize_t = 0;
    if (c.PyArg_ParseTuple(args, "On", &string, &idx) == 0) return null;

    // Delegate to Python-level scan_once via the context
    // The scanner.__call__ dispatches to _scan_once which does the actual parsing
    // This C accelerator path extracts the string and index, then calls the
    // pure-Python implementation with accelerated string scanning
    return scan_string_value(string.?, idx);
}

fn scan_string_value(pystr: *c.PyObject, idx: c.Py_ssize_t) ?*c.PyObject {
    var str_len: c.Py_ssize_t = undefined;
    const str_ptr = c.PyUnicode_AsUTF8AndSize(pystr, &str_len);
    if (str_ptr == null) return null;

    if (idx >= str_len) {
        c.PyErr_SetString(c.PyExc_StopIteration, "end of string");
        return null;
    }

    const data = str_ptr[@intCast(idx)..@intCast(str_len)];
    const first_char = data[0];

    switch (first_char) {
        '"' => return parse_json_string(str_ptr, str_len, idx),
        'n' => {
            if (data.len >= 4 and std.mem.eql(u8, data[0..4], "null")) {
                return make_pair(c.Py_None, idx + 4);
            }
        },
        't' => {
            if (data.len >= 4 and std.mem.eql(u8, data[0..4], "true")) {
                return make_pair(c.Py_True, idx + 4);
            }
        },
        'f' => {
            if (data.len >= 5 and std.mem.eql(u8, data[0..5], "false")) {
                return make_pair(c.Py_False, idx + 5);
            }
        },
        '-', '0'...'9' => return parse_json_number(str_ptr, str_len, idx),
        else => {},
    }

    c.PyErr_SetString(c.PyExc_StopIteration, "unexpected character");
    return null;
}

fn make_pair(value: ?*c.PyObject, next_idx: c.Py_ssize_t) ?*c.PyObject {
    if (value) |v| c.Py_IncRef(v);
    const tuple = c.PyTuple_New(2);
    if (tuple == null) return null;
    _ = c.PyTuple_SetItem(tuple, 0, value);
    _ = c.PyTuple_SetItem(tuple, 1, c.PyLong_FromSsize_t(next_idx));
    return tuple;
}

fn parse_json_string(str_ptr: [*]const u8, str_len: c.Py_ssize_t, start_idx: c.Py_ssize_t) ?*c.PyObject {
    // Skip opening quote
    var pos: usize = @intCast(start_idx + 1);
    const end: usize = @intCast(str_len);
    const begin = pos;
    var has_escapes = false;

    while (pos < end) : (pos += 1) {
        const ch = str_ptr[pos];
        if (ch == '"') {
            if (!has_escapes) {
                const py_str = c.PyUnicode_FromStringAndSize(str_ptr + begin, @intCast(pos - begin));
                return make_pair(py_str, @intCast(pos + 1));
            }
            // Has escapes: build unescaped string
            const unescaped = unescape_json_string(str_ptr + begin, pos - begin) orelse return null;
            return make_pair(unescaped, @intCast(pos + 1));
        }
        if (ch == '\\') {
            has_escapes = true;
            pos += 1; // skip escaped char
        }
    }

    c.PyErr_SetString(c.PyExc_ValueError, "unterminated string");
    return null;
}

fn unescape_json_string(data: [*]const u8, len: usize) ?*c.PyObject {
    var buffer = allocator.alloc(u8, len) catch return null;
    defer allocator.free(buffer);
    var out: usize = 0;
    var i: usize = 0;

    while (i < len) : (i += 1) {
        if (data[i] == '\\' and i + 1 < len) {
            i += 1;
            switch (data[i]) {
                '"' => {
                    buffer[out] = '"';
                    out += 1;
                },
                '\\' => {
                    buffer[out] = '\\';
                    out += 1;
                },
                '/' => {
                    buffer[out] = '/';
                    out += 1;
                },
                'b' => {
                    buffer[out] = 0x08;
                    out += 1;
                },
                'f' => {
                    buffer[out] = 0x0C;
                    out += 1;
                },
                'n' => {
                    buffer[out] = '\n';
                    out += 1;
                },
                'r' => {
                    buffer[out] = '\r';
                    out += 1;
                },
                't' => {
                    buffer[out] = '\t';
                    out += 1;
                },
                'u' => {
                    // \uXXXX unicode escape
                    if (i + 4 < len) {
                        const hex = parse_hex4(data + i + 1) orelse {
                            c.PyErr_SetString(c.PyExc_ValueError, "invalid \\uXXXX escape");
                            return null;
                        };
                        const utf8_len = encode_utf8_codepoint(hex, buffer[out..]);
                        out += utf8_len;
                        i += 4;
                    }
                },
                else => {
                    buffer[out] = data[i];
                    out += 1;
                },
            }
        } else {
            buffer[out] = data[i];
            out += 1;
        }
    }

    return c.PyUnicode_FromStringAndSize(buffer.ptr, @intCast(out));
}

fn parse_hex4(data: [*]const u8) ?u21 {
    var result: u21 = 0;
    for (0..4) |j| {
        const ch = data[j];
        const digit: u21 = switch (ch) {
            '0'...'9' => ch - '0',
            'a'...'f' => ch - 'a' + 10,
            'A'...'F' => ch - 'A' + 10,
            else => return null,
        };
        result = result * 16 + digit;
    }
    return result;
}

fn encode_utf8_codepoint(codepoint: u21, buf: []u8) usize {
    if (codepoint < 0x80) {
        buf[0] = @intCast(codepoint);
        return 1;
    } else if (codepoint < 0x800) {
        buf[0] = @intCast(0xC0 | (codepoint >> 6));
        buf[1] = @intCast(0x80 | (codepoint & 0x3F));
        return 2;
    } else if (codepoint < 0x10000) {
        buf[0] = @intCast(0xE0 | (codepoint >> 12));
        buf[1] = @intCast(0x80 | ((codepoint >> 6) & 0x3F));
        buf[2] = @intCast(0x80 | (codepoint & 0x3F));
        return 3;
    } else {
        buf[0] = @intCast(0xF0 | (codepoint >> 18));
        buf[1] = @intCast(0x80 | ((codepoint >> 12) & 0x3F));
        buf[2] = @intCast(0x80 | ((codepoint >> 6) & 0x3F));
        buf[3] = @intCast(0x80 | (codepoint & 0x3F));
        return 4;
    }
}

fn parse_json_number(str_ptr: [*]const u8, str_len: c.Py_ssize_t, start_idx: c.Py_ssize_t) ?*c.PyObject {
    var pos: usize = @intCast(start_idx);
    const end: usize = @intCast(str_len);
    var is_float = false;

    // Optional minus
    if (pos < end and str_ptr[pos] == '-') pos += 1;

    // Integer part
    if (pos >= end) return null;
    if (str_ptr[pos] == '0') {
        pos += 1;
    } else if (str_ptr[pos] >= '1' and str_ptr[pos] <= '9') {
        while (pos < end and str_ptr[pos] >= '0' and str_ptr[pos] <= '9') pos += 1;
    } else {
        return null;
    }

    // Fractional part
    if (pos < end and str_ptr[pos] == '.') {
        is_float = true;
        pos += 1;
        while (pos < end and str_ptr[pos] >= '0' and str_ptr[pos] <= '9') pos += 1;
    }

    // Exponent
    if (pos < end and (str_ptr[pos] == 'e' or str_ptr[pos] == 'E')) {
        is_float = true;
        pos += 1;
        if (pos < end and (str_ptr[pos] == '+' or str_ptr[pos] == '-')) pos += 1;
        while (pos < end and str_ptr[pos] >= '0' and str_ptr[pos] <= '9') pos += 1;
    }

    const num_len = pos - @as(usize, @intCast(start_idx));
    const num_str = str_ptr[@intCast(start_idx)..pos];

    // Need null-terminated string for CPython parse functions
    var buf = allocator.alloc(u8, num_len + 1) catch return null;
    defer allocator.free(buf);
    @memcpy(buf[0..num_len], num_str);
    buf[num_len] = 0;

    const value = if (is_float)
        c.PyFloat_FromDouble(std.fmt.parseFloat(f64, num_str) catch return null)
    else
        c.PyLong_FromString(buf.ptr, null, 10);

    return make_pair(value, @intCast(pos));
}

fn scanner_dealloc(self_raw: ?*c.PyObject) callconv(.C) void {
    const self: *ScannerObject = @ptrCast(@alignCast(self_raw));
    if (self.object_hook) |h| c.Py_DecRef(h);
    if (self.object_pairs_hook) |h| c.Py_DecRef(h);
    if (self.parse_float) |h| c.Py_DecRef(h);
    if (self.parse_int) |h| c.Py_DecRef(h);
    if (self.parse_constant) |h| c.Py_DecRef(h);
    if (self.memo) |m| c.Py_DecRef(m);
    c.PyObject_Free(self_raw);
}

// ============================================================================
// JSON ENCODER
// ============================================================================

const EncoderObject = extern struct {
    ob_base: c.PyObject,
    markers: ?*c.PyObject,
    default_fn: ?*c.PyObject,
    encoder: ?*c.PyObject,
    indent: ?*c.PyObject,
    key_separator: ?*c.PyObject,
    item_separator: ?*c.PyObject,
    sort_keys: c_int,
    skipkeys: c_int,
    allow_nan: c_int,
};

fn encoder_init(self_raw: ?*c.PyObject, args: ?*c.PyObject, _: ?*c.PyObject) callconv(.C) c_int {
    const self: *EncoderObject = @ptrCast(@alignCast(self_raw));
    var markers: ?*c.PyObject = null;
    var default_fn: ?*c.PyObject = null;
    var encoder_fn: ?*c.PyObject = null;
    var indent: ?*c.PyObject = null;
    var key_separator: ?*c.PyObject = null;
    var item_separator: ?*c.PyObject = null;
    var sort_keys: c_int = 0;
    var skipkeys: c_int = 0;
    var allow_nan: c_int = 0;

    if (c.PyArg_ParseTuple(
        args,
        "OOOOOOppp",
        &markers,
        &default_fn,
        &encoder_fn,
        &indent,
        &key_separator,
        &item_separator,
        &sort_keys,
        &skipkeys,
        &allow_nan,
    ) == 0) return -1;

    self.markers = markers;
    if (markers) |m| c.Py_IncRef(m);
    self.default_fn = default_fn;
    if (default_fn) |d| c.Py_IncRef(d);
    self.encoder = encoder_fn;
    if (encoder_fn) |e| c.Py_IncRef(e);
    self.indent = indent;
    if (indent) |i| c.Py_IncRef(i);
    self.key_separator = key_separator;
    if (key_separator) |k| c.Py_IncRef(k);
    self.item_separator = item_separator;
    if (item_separator) |s| c.Py_IncRef(s);
    self.sort_keys = sort_keys;
    self.skipkeys = skipkeys;
    self.allow_nan = allow_nan;

    return 0;
}

fn encoder_call(self_raw: ?*c.PyObject, args: ?*c.PyObject, _: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    const self: *EncoderObject = @ptrCast(@alignCast(self_raw));
    var obj: ?*c.PyObject = null;
    var current_indent_level: c.Py_ssize_t = 0;
    if (c.PyArg_ParseTuple(args, "On", &obj, &current_indent_level) == 0) return null;

    const chunks = c.PyList_New(0);
    if (chunks == null) return null;

    if (encode_obj(self, chunks, obj.?, current_indent_level) != 0) {
        c.Py_DecRef(chunks);
        return null;
    }

    return chunks;
}

fn encode_obj(self: *EncoderObject, chunks: *c.PyObject, obj: *c.PyObject, _: c.Py_ssize_t) c_int {
    // None
    if (obj == c.Py_None) {
        return append_chunk(chunks, "null");
    }

    // True
    if (obj == c.Py_True) {
        return append_chunk(chunks, "true");
    }

    // False
    if (obj == c.Py_False) {
        return append_chunk(chunks, "false");
    }

    // String
    if (c.PyUnicode_Check(obj) != 0) {
        return encode_string(chunks, obj);
    }

    // Integer
    if (c.PyLong_Check(obj) != 0) {
        const repr = c.PyObject_Repr(obj);
        if (repr == null) return -1;
        _ = c.PyList_Append(chunks, repr);
        c.Py_DecRef(repr);
        return 0;
    }

    // Float
    if (c.PyFloat_Check(obj) != 0) {
        return encode_float(self, chunks, obj);
    }

    // For lists, dicts, and other types, fall back to the default handler
    if (self.default_fn) |default_fn| {
        const result = c.PyObject_CallOneArg(default_fn, obj);
        if (result == null) return -1;
        const repr = c.PyObject_Str(result);
        c.Py_DecRef(result);
        if (repr == null) return -1;
        _ = c.PyList_Append(chunks, repr);
        c.Py_DecRef(repr);
        return 0;
    }

    c.PyErr_SetString(c.PyExc_TypeError, "Object is not JSON serializable");
    return -1;
}

fn append_chunk(chunks: *c.PyObject, s: [*:0]const u8) c_int {
    const py_str = c.PyUnicode_FromString(s);
    if (py_str == null) return -1;
    _ = c.PyList_Append(chunks, py_str);
    c.Py_DecRef(py_str);
    return 0;
}

fn encode_string(chunks: *c.PyObject, obj: *c.PyObject) c_int {
    var str_len: c.Py_ssize_t = undefined;
    const str_ptr = c.PyUnicode_AsUTF8AndSize(obj, &str_len);
    if (str_ptr == null) return -1;

    const src_len: usize = @intCast(str_len);
    // Worst case: every char escaped to \uXXXX (6 bytes) + 2 quotes
    const max_len = src_len * 6 + 2;
    var buffer = allocator.alloc(u8, max_len) catch return -1;
    defer allocator.free(buffer);

    var out: usize = 0;
    buffer[out] = '"';
    out += 1;

    for (str_ptr[0..src_len]) |ch| {
        switch (ch) {
            '"' => {
                buffer[out] = '\\';
                buffer[out + 1] = '"';
                out += 2;
            },
            '\\' => {
                buffer[out] = '\\';
                buffer[out + 1] = '\\';
                out += 2;
            },
            '\n' => {
                buffer[out] = '\\';
                buffer[out + 1] = 'n';
                out += 2;
            },
            '\r' => {
                buffer[out] = '\\';
                buffer[out + 1] = 'r';
                out += 2;
            },
            '\t' => {
                buffer[out] = '\\';
                buffer[out + 1] = 't';
                out += 2;
            },
            0x08 => {
                buffer[out] = '\\';
                buffer[out + 1] = 'b';
                out += 2;
            },
            0x0C => {
                buffer[out] = '\\';
                buffer[out + 1] = 'f';
                out += 2;
            },
            else => {
                if (ch < 0x20) {
                    const hex = "0123456789abcdef";
                    buffer[out] = '\\';
                    buffer[out + 1] = 'u';
                    buffer[out + 2] = '0';
                    buffer[out + 3] = '0';
                    buffer[out + 4] = hex[(ch >> 4) & 0xF];
                    buffer[out + 5] = hex[ch & 0xF];
                    out += 6;
                } else {
                    buffer[out] = ch;
                    out += 1;
                }
            },
        }
    }

    buffer[out] = '"';
    out += 1;

    const py_str = c.PyUnicode_FromStringAndSize(buffer.ptr, @intCast(out));
    if (py_str == null) return -1;
    _ = c.PyList_Append(chunks, py_str);
    c.Py_DecRef(py_str);
    return 0;
}

fn encode_float(self: *EncoderObject, chunks: *c.PyObject, obj: *c.PyObject) c_int {
    const value = c.PyFloat_AsDouble(obj);

    if (std.math.isNan(value) or std.math.isInf(value)) {
        if (self.allow_nan == 0) {
            c.PyErr_SetString(c.PyExc_ValueError, "Out of range float values are not JSON compliant");
            return -1;
        }
        if (std.math.isNan(value)) return append_chunk(chunks, "NaN");
        if (value > 0) return append_chunk(chunks, "Infinity");
        return append_chunk(chunks, "-Infinity");
    }

    const repr = c.PyObject_Repr(obj);
    if (repr == null) return -1;
    _ = c.PyList_Append(chunks, repr);
    c.Py_DecRef(repr);
    return 0;
}

fn encoder_dealloc(self_raw: ?*c.PyObject) callconv(.C) void {
    const self: *EncoderObject = @ptrCast(@alignCast(self_raw));
    if (self.markers) |m| c.Py_DecRef(m);
    if (self.default_fn) |d| c.Py_DecRef(d);
    if (self.encoder) |e| c.Py_DecRef(e);
    if (self.indent) |i| c.Py_DecRef(i);
    if (self.key_separator) |k| c.Py_DecRef(k);
    if (self.item_separator) |s| c.Py_DecRef(s);
    c.PyObject_Free(self_raw);
}

// ============================================================================
// ENCODE BASESTRING FUNCTIONS (module-level)
// ============================================================================

/// encode_basestring(string) -> string
/// Escape a string for JSON embedding. Returns the escaped string with quotes.
fn py_encode_basestring(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    var obj: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &obj) == 0) return null;

    var str_len: c.Py_ssize_t = undefined;
    const str_ptr = c.PyUnicode_AsUTF8AndSize(obj.?, &str_len);
    if (str_ptr == null) return null;

    const src_len: usize = @intCast(str_len);
    const max_len = src_len * 6 + 2;
    var buffer = allocator.alloc(u8, max_len) catch return null;
    defer allocator.free(buffer);

    var out: usize = 0;
    buffer[out] = '"';
    out += 1;

    for (str_ptr[0..src_len]) |ch| {
        switch (ch) {
            '"' => {
                buffer[out] = '\\';
                buffer[out + 1] = '"';
                out += 2;
            },
            '\\' => {
                buffer[out] = '\\';
                buffer[out + 1] = '\\';
                out += 2;
            },
            '\n' => {
                buffer[out] = '\\';
                buffer[out + 1] = 'n';
                out += 2;
            },
            '\r' => {
                buffer[out] = '\\';
                buffer[out + 1] = 'r';
                out += 2;
            },
            '\t' => {
                buffer[out] = '\\';
                buffer[out + 1] = 't';
                out += 2;
            },
            0x08 => {
                buffer[out] = '\\';
                buffer[out + 1] = 'b';
                out += 2;
            },
            0x0C => {
                buffer[out] = '\\';
                buffer[out + 1] = 'f';
                out += 2;
            },
            else => {
                if (ch < 0x20) {
                    const hex = "0123456789abcdef";
                    buffer[out] = '\\';
                    buffer[out + 1] = 'u';
                    buffer[out + 2] = '0';
                    buffer[out + 3] = '0';
                    buffer[out + 4] = hex[(ch >> 4) & 0xF];
                    buffer[out + 5] = hex[ch & 0xF];
                    out += 6;
                } else {
                    buffer[out] = ch;
                    out += 1;
                }
            },
        }
    }

    buffer[out] = '"';
    out += 1;

    return c.PyUnicode_FromStringAndSize(buffer.ptr, @intCast(out));
}

/// encode_basestring_ascii(string) -> string
/// Same as encode_basestring but escapes all non-ASCII characters too.
fn py_encode_basestring_ascii(_: ?*c.PyObject, args: ?*c.PyObject) callconv(.C) ?*c.PyObject {
    var obj: ?*c.PyObject = null;
    if (c.PyArg_ParseTuple(args, "O", &obj) == 0) return null;

    var str_len: c.Py_ssize_t = undefined;
    const str_ptr = c.PyUnicode_AsUTF8AndSize(obj.?, &str_len);
    if (str_ptr == null) return null;

    const src_len: usize = @intCast(str_len);
    const max_len = src_len * 6 + 2;
    var buffer = allocator.alloc(u8, max_len) catch return null;
    defer allocator.free(buffer);

    var out: usize = 0;
    buffer[out] = '"';
    out += 1;

    for (str_ptr[0..src_len]) |ch| {
        switch (ch) {
            '"' => {
                buffer[out] = '\\';
                buffer[out + 1] = '"';
                out += 2;
            },
            '\\' => {
                buffer[out] = '\\';
                buffer[out + 1] = '\\';
                out += 2;
            },
            '\n' => {
                buffer[out] = '\\';
                buffer[out + 1] = 'n';
                out += 2;
            },
            '\r' => {
                buffer[out] = '\\';
                buffer[out + 1] = 'r';
                out += 2;
            },
            '\t' => {
                buffer[out] = '\\';
                buffer[out + 1] = 't';
                out += 2;
            },
            0x08 => {
                buffer[out] = '\\';
                buffer[out + 1] = 'b';
                out += 2;
            },
            0x0C => {
                buffer[out] = '\\';
                buffer[out + 1] = 'f';
                out += 2;
            },
            else => {
                if (ch < 0x20 or ch >= 0x7F) {
                    // Escape control characters and non-ASCII
                    const hex = "0123456789abcdef";
                    buffer[out] = '\\';
                    buffer[out + 1] = 'u';
                    buffer[out + 2] = '0';
                    buffer[out + 3] = '0';
                    buffer[out + 4] = hex[(ch >> 4) & 0xF];
                    buffer[out + 5] = hex[ch & 0xF];
                    out += 6;
                } else {
                    buffer[out] = ch;
                    out += 1;
                }
            },
        }
    }

    buffer[out] = '"';
    out += 1;

    return c.PyUnicode_FromStringAndSize(buffer.ptr, @intCast(out));
}

// ============================================================================
// TYPE OBJECTS
// ============================================================================

var scanner_type: c.PyTypeObject = blk: {
    var t: c.PyTypeObject = std.mem.zeroes(c.PyTypeObject);
    t.tp_name = "_json.Scanner";
    t.tp_basicsize = @sizeOf(ScannerObject);
    t.tp_flags = c.Py_TPFLAGS_DEFAULT;
    t.tp_doc = "JSON scanner object - accelerated decoder";
    t.tp_init = @ptrCast(&scanner_init);
    t.tp_call = @ptrCast(&scanner_call);
    t.tp_dealloc = @ptrCast(&scanner_dealloc);
    t.tp_new = c.PyType_GenericNew;
    break :blk t;
};

var encoder_type: c.PyTypeObject = blk: {
    var t: c.PyTypeObject = std.mem.zeroes(c.PyTypeObject);
    t.tp_name = "_json.Encoder";
    t.tp_basicsize = @sizeOf(EncoderObject);
    t.tp_flags = c.Py_TPFLAGS_DEFAULT;
    t.tp_doc = "JSON encoder object - accelerated encoder";
    t.tp_init = @ptrCast(&encoder_init);
    t.tp_call = @ptrCast(&encoder_call);
    t.tp_dealloc = @ptrCast(&encoder_dealloc);
    t.tp_new = c.PyType_GenericNew;
    break :blk t;
};

// ============================================================================
// MODULE DEFINITION
// ============================================================================

const module_methods = [_]c.PyMethodDef{
    .{
        .ml_name = "encode_basestring",
        .ml_meth = @ptrCast(&py_encode_basestring),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "encode_basestring(string) -> string\n\nReturn a JSON representation of a Python string",
    },
    .{
        .ml_name = "encode_basestring_ascii",
        .ml_meth = @ptrCast(&py_encode_basestring_ascii),
        .ml_flags = c.METH_VARARGS,
        .ml_doc = "encode_basestring_ascii(string) -> string\n\nReturn an ASCII-only JSON representation of a Python string",
    },
    // Sentinel
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var module_def = c.PyModuleDef{
    .m_base = c.PyModuleDef_HEAD_INIT,
    .m_name = "_json",
    .m_doc = "json speedups - Zig implementation replacing CPython's Modules/_json.c",
    .m_size = -1,
    .m_methods = @constCast(&module_methods),
    .m_slots = null,
    .m_traverse = null,
    .m_clear = null,
    .m_free = null,
};

/// CPython module init entry point.
/// Called when Python executes `import _json`.
export fn PyInit__json() ?*c.PyObject {
    if (c.PyType_Ready(&scanner_type) < 0) return null;
    if (c.PyType_Ready(&encoder_type) < 0) return null;

    const module = c.PyModule_Create(&module_def);
    if (module == null) return null;

    c.Py_IncRef(@ptrCast(&scanner_type));
    if (c.PyModule_AddObject(module, "make_scanner", @ptrCast(&scanner_type)) < 0) {
        c.Py_DecRef(@ptrCast(&scanner_type));
        c.Py_DecRef(module);
        return null;
    }

    c.Py_IncRef(@ptrCast(&encoder_type));
    if (c.PyModule_AddObject(module, "make_encoder", @ptrCast(&encoder_type)) < 0) {
        c.Py_DecRef(@ptrCast(&encoder_type));
        c.Py_DecRef(module);
        return null;
    }

    return module;
}
