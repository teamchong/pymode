// CPython extension for zerobuf — zero-copy binary layout in WASM linear memory.
//
// Wraps zerobuf.zig C ABI functions as Python callables. Python operates on
// zerobuf layouts at raw memory offsets — same layout JS writes via the
// zerobuf npm package. No serialization, no copying.
//
// Exports PyInit__zerobuf so CPython loads it as _zerobuf native extension.

const std = @import("std");
const zb = @import("zerobuf.zig");
const py = @cImport({
    @cInclude("Python.h");
});

fn py_none() ?*py.PyObject {
    const none: *py.PyObject = py.Py_None();
    py.Py_INCREF(none);
    return none;
}

fn py_true() ?*py.PyObject {
    const t: *py.PyObject = @ptrCast(&py._Py_TrueStruct);
    py.Py_INCREF(t);
    return t;
}

fn py_false() ?*py.PyObject {
    const f: *py.PyObject = @ptrCast(&py._Py_FalseStruct);
    py.Py_INCREF(f);
    return f;
}

// ============================================================================
// Memory access — WASM linear memory starts at address 0
// ============================================================================

fn get_mem() [*]u8 {
    // WASM linear memory starts at address 0. Use a runtime-computed value
    // to avoid Zig's compile-time null pointer check.
    var addr: usize = 0;
    return @ptrFromInt(addr);
}

fn get_mem_len() u32 {
    // __heap_base is the end of static data; memory.size gives total pages
    // For safety, use a large value — WASM traps on out-of-bounds anyway
    return @as(u32, @truncate(@wasmMemorySize(0))) * 65536;
}

// ============================================================================
// TAG / READ functions
// ============================================================================

// tag(offset) -> int
fn py_tag(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    return py.PyLong_FromLong(@intCast(zb.zerobuf_tag(get_mem(), offset)));
}

// read_i32(offset) -> int
fn py_read_i32(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    return py.PyLong_FromLong(zb.zerobuf_read_i32(get_mem(), offset));
}

// read_f64(offset) -> float
fn py_read_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    return py.PyFloat_FromDouble(zb.zerobuf_read_f64(get_mem(), offset));
}

// read_i64(offset) -> int
fn py_read_i64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    return py.PyLong_FromLongLong(zb.zerobuf_read_i64(get_mem(), offset));
}

// read_bool(offset) -> bool
fn py_read_bool(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    const val = zb.zerobuf_read_bool(get_mem(), offset);
    if (val != 0) {
        return py_true();
    } else {
        return py_false();
    }
}

// read_string(offset) -> str
// offset is the value slot offset (tag byte at offset, string ptr at offset+4)
fn py_read_string(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;

    const mem = get_mem();
    // Check tag is string
    if (mem[offset] != @intFromEnum(zb.Tag.string)) {
        return py.PyUnicode_FromStringAndSize("", 0);
    }
    // Read string ptr from value slot
    const str_ptr = zb.zerobuf_deref(mem, offset + 4);
    if (str_ptr == 0) return py.PyUnicode_FromStringAndSize("", 0);

    const str_len = zb.zerobuf_read_len(mem, str_ptr);
    const data_ptr = zb.zerobuf_read_data_ptr(str_ptr);
    return py.PyUnicode_FromStringAndSize(@ptrCast(mem + data_ptr), @intCast(str_len));
}

// read_bytes(offset) -> bytes
fn py_read_bytes(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;

    const mem = get_mem();
    if (mem[offset] != @intFromEnum(zb.Tag.bytes)) {
        return py.PyBytes_FromStringAndSize("", 0);
    }
    const bytes_ptr = zb.zerobuf_deref(mem, offset + 4);
    if (bytes_ptr == 0) return py.PyBytes_FromStringAndSize("", 0);

    const bytes_len = zb.zerobuf_read_len(mem, bytes_ptr);
    const data_ptr = zb.zerobuf_read_data_ptr(bytes_ptr);
    return py.PyBytes_FromStringAndSize(@ptrCast(mem + data_ptr), @intCast(bytes_len));
}

// ============================================================================
// WRITE functions
// ============================================================================

// write_i32(offset, value) -> None
fn py_write_i32(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    var value: c_int = 0;
    if (py.PyArg_ParseTuple(args, "Ii", &offset, &value) == 0) return null;
    zb.zerobuf_write_i32(get_mem(), offset, value);
    return py_none();
}

// write_f64(offset, value) -> None
fn py_write_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    var value: f64 = 0;
    if (py.PyArg_ParseTuple(args, "Id", &offset, &value) == 0) return null;
    zb.zerobuf_write_f64(get_mem(), offset, value);
    return py_none();
}

// write_i64(offset, value) -> None
fn py_write_i64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    var value: c_longlong = 0;
    if (py.PyArg_ParseTuple(args, "IL", &offset, &value) == 0) return null;
    zb.zerobuf_write_i64(get_mem(), offset, value);
    return py_none();
}

// write_bool(offset, value) -> None
fn py_write_bool(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    var value: c_int = 0;
    if (py.PyArg_ParseTuple(args, "Ip", &offset, &value) == 0) return null;
    zb.zerobuf_write_bool(get_mem(), offset, if (value != 0) 1 else 0);
    return py_none();
}

// write_null(offset) -> None
fn py_write_null(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    zb.zerobuf_write_null(get_mem(), offset);
    return py_none();
}

// ============================================================================
// STRING / LEN helpers
// ============================================================================

// read_len(header_ptr) -> int
fn py_read_len(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var header_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &header_ptr) == 0) return null;
    return py.PyLong_FromUnsignedLong(zb.zerobuf_read_len(get_mem(), header_ptr));
}

// deref(handle_ptr) -> int
fn py_deref(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &handle_ptr) == 0) return null;
    return py.PyLong_FromUnsignedLong(zb.zerobuf_deref(get_mem(), handle_ptr));
}

// ============================================================================
// ARRAY functions
// ============================================================================

// array_len(handle_ptr) -> int
fn py_array_len(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &handle_ptr) == 0) return null;
    return py.PyLong_FromUnsignedLong(zb.zerobuf_array_len(get_mem(), handle_ptr));
}

// array_element_offset(handle_ptr, index) -> int
fn py_array_element_offset(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var index: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "II", &handle_ptr, &index) == 0) return null;
    return py.PyLong_FromUnsignedLong(zb.zerobuf_array_element_offset(get_mem(), handle_ptr, index));
}

// ============================================================================
// OBJECT functions
// ============================================================================

// object_count(handle_ptr) -> int
fn py_object_count(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &handle_ptr) == 0) return null;
    return py.PyLong_FromUnsignedLong(zb.zerobuf_object_count(get_mem(), handle_ptr));
}

// object_find(handle_ptr, key) -> int (value slot offset, or 0xFFFFFFFF if not found)
fn py_object_find(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;
    const result = zb.zerobuf_object_find(get_mem(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len));
    return py.PyLong_FromUnsignedLong(result);
}

// object_get_f64(handle_ptr, key) -> float
fn py_object_get_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;
    return py.PyFloat_FromDouble(zb.zerobuf_object_get_f64(get_mem(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len)));
}

// object_get_i32(handle_ptr, key) -> int
fn py_object_get_i32(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;
    return py.PyLong_FromLong(zb.zerobuf_object_get_i32(get_mem(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len)));
}

// object_get_i64(handle_ptr, key) -> int
fn py_object_get_i64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;
    return py.PyLong_FromLongLong(zb.zerobuf_object_get_i64(get_mem(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len)));
}

// object_get_string(handle_ptr, key) -> str
fn py_object_get_string(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;

    var out_len: u32 = 0;
    const str_data_ptr = zb.zerobuf_object_get_string(get_mem(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len), &out_len);
    if (str_data_ptr == 0 and out_len == 0) {
        return py.PyUnicode_FromStringAndSize("", 0);
    }
    return py.PyUnicode_FromStringAndSize(@ptrCast(get_mem() + str_data_ptr), @intCast(out_len));
}

// object_set_f64(handle_ptr, key, value) -> bool
fn py_object_set_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    var value: f64 = 0;
    if (py.PyArg_ParseTuple(args, "Is#d", &handle_ptr, &key_ptr, &key_len, &value) == 0) return null;
    const ok = zb.zerobuf_object_set_f64(get_mem(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len), value);
    if (ok != 0) {
        return py_true();
    } else {
        return py_false();
    }
}

// object_set_i32(handle_ptr, key, value) -> bool
fn py_object_set_i32(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    var value: c_int = 0;
    if (py.PyArg_ParseTuple(args, "Is#i", &handle_ptr, &key_ptr, &key_len, &value) == 0) return null;
    const ok = zb.zerobuf_object_set_i32(get_mem(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len), value);
    if (ok != 0) {
        return py_true();
    } else {
        return py_false();
    }
}

// object_set_i64(handle_ptr, key, value) -> bool
fn py_object_set_i64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    var value: c_longlong = 0;
    if (py.PyArg_ParseTuple(args, "Is#L", &handle_ptr, &key_ptr, &key_len, &value) == 0) return null;
    const ok = zb.zerobuf_object_set_i64(get_mem(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len), value);
    if (ok != 0) {
        return py_true();
    } else {
        return py_false();
    }
}

// ============================================================================
// STRING WRITE — write a zerobuf string (header + data) at a given address
// ============================================================================

// write_string_at(pool_addr, string) -> int (bytes written: header + data)
fn py_write_string_at(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var pool_addr: c_uint = 0;
    var str_ptr: [*]const u8 = undefined;
    var str_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &pool_addr, &str_ptr, &str_len) == 0) return null;

    const mem = get_mem();
    const byte_len: u32 = @intCast(str_len);

    // Write string header (4-byte length prefix)
    std.mem.writeInt(u32, @as(*[4]u8, @ptrCast(mem + pool_addr)), byte_len, .little);
    // Write string bytes
    const dest: [*]u8 = mem + pool_addr + zb.STRING_HEADER;
    @memcpy(dest[0..byte_len], str_ptr[0..byte_len]);

    return py.PyLong_FromUnsignedLong(zb.STRING_HEADER + byte_len);
}

// write_string_slot(slot_offset, string_header_ptr) -> None
// Writes TAG_STRING + pointer at the value slot
fn py_write_string_slot(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var slot_offset: c_uint = 0;
    var header_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "II", &slot_offset, &header_ptr) == 0) return null;

    const mem = get_mem();
    zb.writeStringRef(mem[0..slot_offset + zb.VALUE_SLOT], slot_offset, header_ptr);
    return py_none();
}

// ============================================================================
// SCHEMA helpers — fixed-layout objects (field at base + index * 16)
// ============================================================================

// schema_read_field(base, index) -> value (auto-detects type from tag)
fn py_schema_read_field(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var base: c_uint = 0;
    var index: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "II", &base, &index) == 0) return null;

    const offset = base + index * zb.VALUE_SLOT;
    const mem = get_mem();
    const tag: zb.Tag = @enumFromInt(mem[offset]);

    return switch (tag) {
        .null => blk: {
            py.Py_INCREF(py.Py_None());
            break :blk py.Py_None();
        },
        .bool => blk: {
            const val = zb.zerobuf_read_bool(mem, offset);
            break :blk if (val != 0) py_true() else py_false();
        },
        .i32 => py.PyLong_FromLong(zb.zerobuf_read_i32(mem, offset)),
        .f64 => py.PyFloat_FromDouble(zb.zerobuf_read_f64(mem, offset)),
        .bigint => py.PyLong_FromLongLong(zb.zerobuf_read_i64(mem, offset)),
        .string => blk: {
            const str_header_ptr = std.mem.readInt(u32, @as(*const [4]u8, @ptrCast(mem + offset + 4)), .little);
            if (str_header_ptr == 0) break :blk py.PyUnicode_FromStringAndSize("", 0);
            const str_len = zb.zerobuf_read_len(mem, str_header_ptr);
            const data_ptr = zb.zerobuf_read_data_ptr(str_header_ptr);
            break :blk py.PyUnicode_FromStringAndSize(@ptrCast(mem + data_ptr), @intCast(str_len));
        },
        .bytes => blk: {
            const bytes_header_ptr = std.mem.readInt(u32, @as(*const [4]u8, @ptrCast(mem + offset + 4)), .little);
            if (bytes_header_ptr == 0) break :blk py.PyBytes_FromStringAndSize("", 0);
            const bytes_len = zb.zerobuf_read_len(mem, bytes_header_ptr);
            const data_ptr = zb.zerobuf_read_data_ptr(bytes_header_ptr);
            break :blk py.PyBytes_FromStringAndSize(@ptrCast(mem + data_ptr), @intCast(bytes_len));
        },
        .array, .object => blk: {
            // Return the handle pointer as int — caller uses array_*/object_* functions
            const handle_ptr = std.mem.readInt(u32, @as(*const [4]u8, @ptrCast(mem + offset + 4)), .little);
            break :blk py.PyLong_FromUnsignedLong(handle_ptr);
        },
    };
}

// ============================================================================
// CONSTANTS
// ============================================================================

// ============================================================================
// MODULE DEFINITION
// ============================================================================

var module_methods = [_]py.PyMethodDef{
    // Read
    .{ .ml_name = "tag", .ml_meth = @ptrCast(&py_tag), .ml_flags = py.METH_VARARGS, .ml_doc = "Get tag byte at offset." },
    .{ .ml_name = "read_i32", .ml_meth = @ptrCast(&py_read_i32), .ml_flags = py.METH_VARARGS, .ml_doc = "Read i32 from tagged value slot." },
    .{ .ml_name = "read_f64", .ml_meth = @ptrCast(&py_read_f64), .ml_flags = py.METH_VARARGS, .ml_doc = "Read f64 from tagged value slot." },
    .{ .ml_name = "read_i64", .ml_meth = @ptrCast(&py_read_i64), .ml_flags = py.METH_VARARGS, .ml_doc = "Read i64 from tagged value slot." },
    .{ .ml_name = "read_bool", .ml_meth = @ptrCast(&py_read_bool), .ml_flags = py.METH_VARARGS, .ml_doc = "Read bool from tagged value slot." },
    .{ .ml_name = "read_string", .ml_meth = @ptrCast(&py_read_string), .ml_flags = py.METH_VARARGS, .ml_doc = "Read string from tagged value slot." },
    .{ .ml_name = "read_bytes", .ml_meth = @ptrCast(&py_read_bytes), .ml_flags = py.METH_VARARGS, .ml_doc = "Read bytes from tagged value slot." },
    .{ .ml_name = "read_len", .ml_meth = @ptrCast(&py_read_len), .ml_flags = py.METH_VARARGS, .ml_doc = "Read string/bytes length from header." },
    .{ .ml_name = "deref", .ml_meth = @ptrCast(&py_deref), .ml_flags = py.METH_VARARGS, .ml_doc = "Dereference a handle pointer." },
    // Write
    .{ .ml_name = "write_i32", .ml_meth = @ptrCast(&py_write_i32), .ml_flags = py.METH_VARARGS, .ml_doc = "Write i32 tagged value." },
    .{ .ml_name = "write_f64", .ml_meth = @ptrCast(&py_write_f64), .ml_flags = py.METH_VARARGS, .ml_doc = "Write f64 tagged value." },
    .{ .ml_name = "write_i64", .ml_meth = @ptrCast(&py_write_i64), .ml_flags = py.METH_VARARGS, .ml_doc = "Write i64 tagged value." },
    .{ .ml_name = "write_bool", .ml_meth = @ptrCast(&py_write_bool), .ml_flags = py.METH_VARARGS, .ml_doc = "Write bool tagged value." },
    .{ .ml_name = "write_null", .ml_meth = @ptrCast(&py_write_null), .ml_flags = py.METH_VARARGS, .ml_doc = "Write null tagged value." },
    // Array
    .{ .ml_name = "array_len", .ml_meth = @ptrCast(&py_array_len), .ml_flags = py.METH_VARARGS, .ml_doc = "Get array length from handle." },
    .{ .ml_name = "array_element_offset", .ml_meth = @ptrCast(&py_array_element_offset), .ml_flags = py.METH_VARARGS, .ml_doc = "Get array element value slot offset." },
    // Object
    .{ .ml_name = "object_count", .ml_meth = @ptrCast(&py_object_count), .ml_flags = py.METH_VARARGS, .ml_doc = "Get object property count." },
    .{ .ml_name = "object_find", .ml_meth = @ptrCast(&py_object_find), .ml_flags = py.METH_VARARGS, .ml_doc = "Find object property value slot offset." },
    .{ .ml_name = "object_get_f64", .ml_meth = @ptrCast(&py_object_get_f64), .ml_flags = py.METH_VARARGS, .ml_doc = "Get f64 from object property." },
    .{ .ml_name = "object_get_i32", .ml_meth = @ptrCast(&py_object_get_i32), .ml_flags = py.METH_VARARGS, .ml_doc = "Get i32 from object property." },
    .{ .ml_name = "object_get_i64", .ml_meth = @ptrCast(&py_object_get_i64), .ml_flags = py.METH_VARARGS, .ml_doc = "Get i64 from object property." },
    .{ .ml_name = "object_get_string", .ml_meth = @ptrCast(&py_object_get_string), .ml_flags = py.METH_VARARGS, .ml_doc = "Get string from object property." },
    .{ .ml_name = "object_set_f64", .ml_meth = @ptrCast(&py_object_set_f64), .ml_flags = py.METH_VARARGS, .ml_doc = "Set f64 on object property." },
    .{ .ml_name = "object_set_i32", .ml_meth = @ptrCast(&py_object_set_i32), .ml_flags = py.METH_VARARGS, .ml_doc = "Set i32 on object property." },
    .{ .ml_name = "object_set_i64", .ml_meth = @ptrCast(&py_object_set_i64), .ml_flags = py.METH_VARARGS, .ml_doc = "Set i64 on object property." },
    // String write
    .{ .ml_name = "write_string_at", .ml_meth = @ptrCast(&py_write_string_at), .ml_flags = py.METH_VARARGS, .ml_doc = "Write string header+data at pool address. Returns bytes written." },
    .{ .ml_name = "write_string_slot", .ml_meth = @ptrCast(&py_write_string_slot), .ml_flags = py.METH_VARARGS, .ml_doc = "Write string tag+pointer at value slot." },
    // Schema
    .{ .ml_name = "schema_read_field", .ml_meth = @ptrCast(&py_schema_read_field), .ml_flags = py.METH_VARARGS, .ml_doc = "Read typed value from schema field (base + index * 16)." },
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var module_def = py.PyModuleDef{
    .m_base = std.mem.zeroes(py.PyModuleDef_Base),
    .m_name = "_zerobuf",
    .m_doc = "Zero-copy binary layout for WASM linear memory — matches zerobuf npm package",
    .m_size = -1,
    .m_methods = @constCast(&module_methods),
    .m_slots = null,
    .m_traverse = null,
    .m_clear = null,
    .m_free = null,
};

export fn PyInit__zerobuf() ?*py.PyObject {
    const module = py.PyModule_Create(&module_def) orelse return null;

    // Export layout constants so Python matches JS
    _ = py.PyModule_AddIntConstant(module, "VALUE_SLOT", zb.VALUE_SLOT);
    _ = py.PyModule_AddIntConstant(module, "STRING_HEADER", zb.STRING_HEADER);
    _ = py.PyModule_AddIntConstant(module, "ARRAY_HEADER", zb.ARRAY_HEADER);
    _ = py.PyModule_AddIntConstant(module, "OBJECT_HEADER", zb.OBJECT_HEADER);
    _ = py.PyModule_AddIntConstant(module, "OBJECT_ENTRY", zb.OBJECT_ENTRY);

    // Tag constants
    _ = py.PyModule_AddIntConstant(module, "TAG_NULL", @intFromEnum(zb.Tag.null));
    _ = py.PyModule_AddIntConstant(module, "TAG_BOOL", @intFromEnum(zb.Tag.bool));
    _ = py.PyModule_AddIntConstant(module, "TAG_I32", @intFromEnum(zb.Tag.i32));
    _ = py.PyModule_AddIntConstant(module, "TAG_F64", @intFromEnum(zb.Tag.f64));
    _ = py.PyModule_AddIntConstant(module, "TAG_STRING", @intFromEnum(zb.Tag.string));
    _ = py.PyModule_AddIntConstant(module, "TAG_ARRAY", @intFromEnum(zb.Tag.array));
    _ = py.PyModule_AddIntConstant(module, "TAG_OBJECT", @intFromEnum(zb.Tag.object));
    _ = py.PyModule_AddIntConstant(module, "TAG_BIGINT", @intFromEnum(zb.Tag.bigint));
    _ = py.PyModule_AddIntConstant(module, "TAG_BYTES", @intFromEnum(zb.Tag.bytes));

    return module;
}
