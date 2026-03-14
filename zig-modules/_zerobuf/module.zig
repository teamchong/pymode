// CPython extension for zerobuf — zero-copy binary layout in WASM linear memory.
//
// Wraps zerobuf.zig C ABI functions as Python callables. Python operates on
// zerobuf layouts at raw memory offsets — same layout JS writes via the
// zerobuf npm package. No serialization, no copying.
//
// Exports PyInit__zerobuf so CPython loads it as _zerobuf native extension.
//
// IMPORTANT: WASM linear memory starts at address 0. Zig treats @ptrFromInt(0)
// as a null pointer and LLVM optimizes away dereferences in ReleaseFast.
// All memory access MUST go through wasm_ptr() which returns [*]allowzero u8.

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
// Memory access — WASM linear memory via allowzero pointers
// ============================================================================

/// Get a pointer to WASM linear memory at address 0.
/// Uses [*]allowzero u8 to tell Zig that address 0 is valid (as it is in WASM).
/// This prevents LLVM from optimizing away memory accesses as "null deref UB".
fn wasm_ptr() [*]allowzero u8 {
    return @ptrFromInt(0);
}

fn wasm_ptr_const() [*]allowzero const u8 {
    return @ptrFromInt(0);
}

/// Load a byte from WASM linear memory at the given address.
fn wasm_load_u8(addr: u32) u8 {
    return wasm_ptr_const()[addr];
}

/// Load a little-endian u32 from WASM linear memory.
fn wasm_load_u32(addr: u32) u32 {
    const p = wasm_ptr_const() + addr;
    return std.mem.readInt(u32, @as(*const [4]u8, @ptrCast(p)), .little);
}

/// Load a little-endian i32 from WASM linear memory.
fn wasm_load_i32(addr: u32) i32 {
    const p = wasm_ptr_const() + addr;
    return std.mem.readInt(i32, @as(*const [4]u8, @ptrCast(p)), .little);
}

/// Load a little-endian f64 from WASM linear memory.
fn wasm_load_f64(addr: u32) f64 {
    const p = wasm_ptr_const() + addr;
    return @bitCast(std.mem.readInt(u64, @as(*const [8]u8, @ptrCast(p)), .little));
}

/// Load a little-endian i64 from WASM linear memory.
fn wasm_load_i64(addr: u32) i64 {
    const p = wasm_ptr_const() + addr;
    return std.mem.readInt(i64, @as(*const [8]u8, @ptrCast(p)), .little);
}

/// Store a little-endian u32 to WASM linear memory.
fn wasm_store_u32(addr: u32, val: u32) void {
    const p = wasm_ptr() + addr;
    std.mem.writeInt(u32, @as(*[4]u8, @ptrCast(p)), val, .little);
}

/// Store a byte to WASM linear memory.
fn wasm_store_u8(addr: u32, val: u8) void {
    wasm_ptr()[addr] = val;
}

fn get_mem_len() u32 {
    return @as(u32, @truncate(@wasmMemorySize(0))) * 65536;
}

// ============================================================================
// TAG / READ functions
// ============================================================================

// tag(offset) -> int
fn py_tag(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    return py.PyLong_FromLong(@intCast(wasm_load_u8(offset)));
}

// read_i32(offset) -> int
fn py_read_i32(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    if (wasm_load_u8(offset) != @intFromEnum(zb.Tag.i32)) return py.PyLong_FromLong(0);
    return py.PyLong_FromLong(wasm_load_i32(offset + 4));
}

// read_f64(offset) -> float
fn py_read_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    if (wasm_load_u8(offset) != @intFromEnum(zb.Tag.f64)) return py.PyFloat_FromDouble(0);
    return py.PyFloat_FromDouble(wasm_load_f64(offset + 8));
}

// read_i64(offset) -> int
fn py_read_i64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    if (wasm_load_u8(offset) != @intFromEnum(zb.Tag.bigint)) return py.PyLong_FromLongLong(0);
    return py.PyLong_FromLongLong(wasm_load_i64(offset + 8));
}

// read_bool(offset) -> bool
fn py_read_bool(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    if (wasm_load_u8(offset) != @intFromEnum(zb.Tag.bool)) return py_false();
    if (wasm_load_u32(offset + 4) != 0) {
        return py_true();
    } else {
        return py_false();
    }
}

// read_string(offset) -> str
fn py_read_string(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;

    if (wasm_load_u8(offset) != @intFromEnum(zb.Tag.string)) {
        return py.PyUnicode_FromStringAndSize("", 0);
    }
    const str_header_ptr = wasm_load_u32(offset + 4);
    if (str_header_ptr == 0) return py.PyUnicode_FromStringAndSize("", 0);

    const str_len = wasm_load_u32(str_header_ptr);
    const data_addr = str_header_ptr + zb.STRING_HEADER;
    return py.PyUnicode_FromStringAndSize(@ptrCast(wasm_ptr_const() + data_addr), @intCast(str_len));
}

// read_bytes(offset) -> bytes
fn py_read_bytes(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;

    if (wasm_load_u8(offset) != @intFromEnum(zb.Tag.bytes)) {
        return py.PyBytes_FromStringAndSize("", 0);
    }
    const bytes_header_ptr = wasm_load_u32(offset + 4);
    if (bytes_header_ptr == 0) return py.PyBytes_FromStringAndSize("", 0);

    const bytes_len = wasm_load_u32(bytes_header_ptr);
    const data_addr = bytes_header_ptr + zb.STRING_HEADER;
    return py.PyBytes_FromStringAndSize(@ptrCast(wasm_ptr_const() + data_addr), @intCast(bytes_len));
}

// ============================================================================
// WRITE functions
// ============================================================================

// write_i32(offset, value) -> None
fn py_write_i32(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    var value: c_int = 0;
    if (py.PyArg_ParseTuple(args, "Ii", &offset, &value) == 0) return null;
    wasm_store_u8(offset, @intFromEnum(zb.Tag.i32));
    const p = wasm_ptr() + offset + 4;
    std.mem.writeInt(i32, @as(*[4]u8, @ptrCast(p)), value, .little);
    return py_none();
}

// write_f64(offset, value) -> None
fn py_write_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    var value: f64 = 0;
    if (py.PyArg_ParseTuple(args, "Id", &offset, &value) == 0) return null;
    wasm_store_u8(offset, @intFromEnum(zb.Tag.f64));
    const p = wasm_ptr() + offset + 8;
    std.mem.writeInt(u64, @as(*[8]u8, @ptrCast(p)), @bitCast(value), .little);
    return py_none();
}

// write_i64(offset, value) -> None
fn py_write_i64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    var value: c_longlong = 0;
    if (py.PyArg_ParseTuple(args, "IL", &offset, &value) == 0) return null;
    wasm_store_u8(offset, @intFromEnum(zb.Tag.bigint));
    const p = wasm_ptr() + offset + 8;
    std.mem.writeInt(i64, @as(*[8]u8, @ptrCast(p)), value, .little);
    return py_none();
}

// write_bool(offset, value) -> None
fn py_write_bool(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    var value: c_int = 0;
    if (py.PyArg_ParseTuple(args, "Ip", &offset, &value) == 0) return null;
    wasm_store_u8(offset, @intFromEnum(zb.Tag.bool));
    wasm_store_u32(offset + 4, if (value != 0) 1 else 0);
    return py_none();
}

// write_null(offset) -> None
fn py_write_null(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var offset: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &offset) == 0) return null;
    wasm_store_u8(offset, @intFromEnum(zb.Tag.null));
    return py_none();
}

// ============================================================================
// STRING / LEN helpers
// ============================================================================

// read_len(header_ptr) -> int
fn py_read_len(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var header_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &header_ptr) == 0) return null;
    return py.PyLong_FromUnsignedLong(wasm_load_u32(header_ptr));
}

// deref(handle_ptr) -> int
fn py_deref(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &handle_ptr) == 0) return null;
    return py.PyLong_FromUnsignedLong(wasm_load_u32(handle_ptr));
}

// ============================================================================
// ARRAY functions
// ============================================================================

// array_len(handle_ptr) -> int
fn py_array_len(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &handle_ptr) == 0) return null;
    const data_ptr = wasm_load_u32(handle_ptr);
    return py.PyLong_FromUnsignedLong(wasm_load_u32(data_ptr + 4));
}

// array_element_offset(handle_ptr, index) -> int
fn py_array_element_offset(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var index: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "II", &handle_ptr, &index) == 0) return null;
    const data_ptr = wasm_load_u32(handle_ptr);
    return py.PyLong_FromUnsignedLong(data_ptr + zb.ARRAY_HEADER + index * zb.VALUE_SLOT);
}

// ============================================================================
// OBJECT functions — use zerobuf.zig C ABI with non-null pointer
// ============================================================================

/// Get a non-null [*]u8 pointer to WASM memory for zerobuf C ABI functions.
/// These functions take [*]const u8 + offset, so we use address 0 via allowzero
/// and immediately cast. The C ABI functions will add the offset, producing
/// a non-zero WASM address for the actual load instruction.
fn get_mem_for_zb() [*]u8 {
    // Use a global variable's address (always > 0) and subtract to get base 0.
    // The key insight: zerobuf C ABI functions do `mem + offset` to compute
    // the actual address. As long as offset > 0 (which it always is for valid
    // zerobuf data), the final address is non-zero and the load works.
    //
    // We use @ptrFromInt(0) via allowzero and then @ptrCast to [*]u8.
    // This is safe because: (1) we never dereference at offset 0, and
    // (2) the allowzero -> non-allowzero cast is valid when the pointer
    // is only used with non-zero offsets.
    const azp: [*]allowzero u8 = @ptrFromInt(0);
    return @ptrCast(azp);
}

fn get_mem_for_zb_const() [*]const u8 {
    const azp: [*]allowzero const u8 = @ptrFromInt(0);
    return @ptrCast(azp);
}

// object_count(handle_ptr) -> int
fn py_object_count(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "I", &handle_ptr) == 0) return null;
    return py.PyLong_FromUnsignedLong(zb.zerobuf_object_count(get_mem_for_zb_const(), handle_ptr));
}

// object_find(handle_ptr, key) -> int (value slot offset, or 0xFFFFFFFF if not found)
fn py_object_find(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;
    const result = zb.zerobuf_object_find(get_mem_for_zb_const(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len));
    return py.PyLong_FromUnsignedLong(result);
}

// object_get_f64(handle_ptr, key) -> float
fn py_object_get_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;
    return py.PyFloat_FromDouble(zb.zerobuf_object_get_f64(get_mem_for_zb_const(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len)));
}

// object_get_i32(handle_ptr, key) -> int
fn py_object_get_i32(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;
    return py.PyLong_FromLong(zb.zerobuf_object_get_i32(get_mem_for_zb_const(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len)));
}

// object_get_i64(handle_ptr, key) -> int
fn py_object_get_i64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;
    return py.PyLong_FromLongLong(zb.zerobuf_object_get_i64(get_mem_for_zb_const(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len)));
}

// object_get_string(handle_ptr, key) -> str
fn py_object_get_string(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    if (py.PyArg_ParseTuple(args, "Is#", &handle_ptr, &key_ptr, &key_len) == 0) return null;

    var out_len: u32 = 0;
    const str_data_ptr = zb.zerobuf_object_get_string(get_mem_for_zb_const(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len), &out_len);
    if (str_data_ptr == 0 and out_len == 0) {
        return py.PyUnicode_FromStringAndSize("", 0);
    }
    return py.PyUnicode_FromStringAndSize(@ptrCast(wasm_ptr_const() + str_data_ptr), @intCast(out_len));
}

// object_set_f64(handle_ptr, key, value) -> bool
fn py_object_set_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var handle_ptr: c_uint = 0;
    var key_ptr: [*]const u8 = undefined;
    var key_len: py.Py_ssize_t = 0;
    var value: f64 = 0;
    if (py.PyArg_ParseTuple(args, "Is#d", &handle_ptr, &key_ptr, &key_len, &value) == 0) return null;
    const ok = zb.zerobuf_object_set_f64(get_mem_for_zb(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len), value);
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
    const ok = zb.zerobuf_object_set_i32(get_mem_for_zb(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len), value);
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
    const ok = zb.zerobuf_object_set_i64(get_mem_for_zb(), get_mem_len(), handle_ptr, key_ptr, @intCast(key_len), value);
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

    const byte_len: u32 = @intCast(str_len);

    // Write string header (4-byte length prefix)
    wasm_store_u32(pool_addr, byte_len);
    // Write string bytes
    const dest = wasm_ptr() + pool_addr + zb.STRING_HEADER;
    @memcpy(dest[0..byte_len], str_ptr[0..byte_len]);

    return py.PyLong_FromUnsignedLong(zb.STRING_HEADER + byte_len);
}

// write_string_slot(slot_offset, string_header_ptr) -> None
fn py_write_string_slot(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var slot_offset: c_uint = 0;
    var header_ptr: c_uint = 0;
    if (py.PyArg_ParseTuple(args, "II", &slot_offset, &header_ptr) == 0) return null;

    wasm_store_u8(slot_offset, @intFromEnum(zb.Tag.string));
    wasm_store_u32(slot_offset + 4, header_ptr);
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
    const raw_tag = wasm_load_u8(offset);

    // Safety check: tag must be a valid zerobuf Tag (0-8)
    if (raw_tag > 8) {
        var buf: [128]u8 = undefined;
        const msg = std.fmt.bufPrint(&buf, "zerobuf: invalid tag {d} at offset {d} (base={d}, idx={d})\x00", .{ raw_tag, offset, base, index }) catch "zerobuf: invalid tag\x00";
        py.PyErr_SetString(py.PyExc_ValueError, @ptrCast(msg.ptr));
        return null;
    }

    const tag: zb.Tag = @enumFromInt(raw_tag);

    return switch (tag) {
        .null => blk: {
            py.Py_INCREF(py.Py_None());
            break :blk py.Py_None();
        },
        .bool => blk: {
            const val = wasm_load_u32(offset + 4);
            break :blk if (val != 0) py_true() else py_false();
        },
        .i32 => py.PyLong_FromLong(wasm_load_i32(offset + 4)),
        .f64 => py.PyFloat_FromDouble(wasm_load_f64(offset + 8)),
        .bigint => py.PyLong_FromLongLong(wasm_load_i64(offset + 8)),
        .string => blk: {
            const str_header_ptr = wasm_load_u32(offset + 4);
            if (str_header_ptr == 0) break :blk py.PyUnicode_FromStringAndSize("", 0);
            const str_len = wasm_load_u32(str_header_ptr);
            const data_addr = str_header_ptr + zb.STRING_HEADER;
            break :blk py.PyUnicode_FromStringAndSize(@ptrCast(wasm_ptr_const() + data_addr), @intCast(str_len));
        },
        .bytes => blk: {
            const bytes_header_ptr = wasm_load_u32(offset + 4);
            if (bytes_header_ptr == 0) break :blk py.PyBytes_FromStringAndSize("", 0);
            const bytes_len = wasm_load_u32(bytes_header_ptr);
            const data_addr = bytes_header_ptr + zb.STRING_HEADER;
            break :blk py.PyBytes_FromStringAndSize(@ptrCast(wasm_ptr_const() + data_addr), @intCast(bytes_len));
        },
        .array, .object => blk: {
            const handle_ptr = wasm_load_u32(offset + 4);
            break :blk py.PyLong_FromUnsignedLong(handle_ptr);
        },
    };
}

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
