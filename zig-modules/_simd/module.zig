// Zig CPython extension for SIMD batch operations on numeric arrays.
//
// Operates directly on buffer protocol objects (array.array, bytes, memoryview)
// in WASM linear memory — zero copy. Uses Zig @Vector types which compile to
// WASM SIMD v128 instructions.
//
// Exports PyInit__simd so CPython loads it as _simd native extension.

const std = @import("std");
const py = @cImport({
    @cInclude("Python.h");
});

fn py_none() ?*py.PyObject {
    const none: *py.PyObject = py.Py_None();
    py.Py_INCREF(none);
    return none;
}

// ============================================================================
// SIMD CORE — @Vector maps to WASM v128
// ============================================================================

const VEC_F64_LEN = 2; // v128 = 2 x f64
const VEC_I32_LEN = 4; // v128 = 4 x i32

fn simd_sum_f64(data: [*]const f64, len: usize) f64 {
    if (len == 0) return 0;
    var acc: @Vector(VEC_F64_LEN, f64) = @splat(0);
    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const vecs: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(data));
    for (0..chunks) |i| {
        acc += vecs[i];
    }

    var total: f64 = @reduce(.Add, acc);
    const tail = data[chunks * VEC_F64_LEN ..];
    for (0..remainder) |i| {
        total += tail[i];
    }
    return total;
}

fn simd_sum_i32(data: [*]const i32, len: usize) i64 {
    if (len == 0) return 0;
    var total: i64 = 0;
    const chunks = len / VEC_I32_LEN;
    const remainder = len % VEC_I32_LEN;

    const vecs: [*]const @Vector(VEC_I32_LEN, i32) = @alignCast(@ptrCast(data));
    for (0..chunks) |i| {
        const chunk = vecs[i];
        const lo: @Vector(2, i64) = .{ chunk[0], chunk[1] };
        const hi: @Vector(2, i64) = .{ chunk[2], chunk[3] };
        total += @reduce(.Add, lo) + @reduce(.Add, hi);
    }

    const tail = data[chunks * VEC_I32_LEN ..];
    for (0..remainder) |i| {
        total += tail[i];
    }
    return total;
}

fn simd_scale_f64(data: [*]f64, len: usize, scalar: f64) void {
    if (len == 0) return;
    const s: @Vector(VEC_F64_LEN, f64) = @splat(scalar);
    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const vecs: [*]@Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(data));
    for (0..chunks) |i| {
        vecs[i] *= s;
    }

    const tail = data[chunks * VEC_F64_LEN ..];
    for (0..remainder) |i| {
        tail[i] *= scalar;
    }
}

fn simd_dot_f64(a: [*]const f64, b: [*]const f64, len: usize) f64 {
    if (len == 0) return 0;
    var acc: @Vector(VEC_F64_LEN, f64) = @splat(0);
    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const va: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(a));
    const vb: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(b));
    for (0..chunks) |i| {
        acc += va[i] * vb[i];
    }

    var total: f64 = @reduce(.Add, acc);
    const ta = a[chunks * VEC_F64_LEN ..];
    const tb = b[chunks * VEC_F64_LEN ..];
    for (0..remainder) |i| {
        total += ta[i] * tb[i];
    }
    return total;
}

fn simd_add_f64(dst: [*]f64, a: [*]const f64, b: [*]const f64, len: usize) void {
    if (len == 0) return;
    const chunks = len / VEC_F64_LEN;
    const remainder = len % VEC_F64_LEN;

    const vd: [*]@Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(dst));
    const va: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(a));
    const vb: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(b));
    for (0..chunks) |i| {
        vd[i] = va[i] + vb[i];
    }

    const td = dst[chunks * VEC_F64_LEN ..];
    const ta = a[chunks * VEC_F64_LEN ..];
    const tb = b[chunks * VEC_F64_LEN ..];
    for (0..remainder) |i| {
        td[i] = ta[i] + tb[i];
    }
}

fn simd_minmax_f64(data: [*]const f64, len: usize) struct { min: f64, max: f64 } {
    if (len == 0) return .{ .min = 0, .max = 0 };

    var min_val: f64 = data[0];
    var max_val: f64 = data[0];

    if (len >= VEC_F64_LEN) {
        var min_acc: @Vector(VEC_F64_LEN, f64) = @splat(data[0]);
        var max_acc: @Vector(VEC_F64_LEN, f64) = @splat(data[0]);
        const chunks = len / VEC_F64_LEN;
        const vecs: [*]const @Vector(VEC_F64_LEN, f64) = @alignCast(@ptrCast(data));

        for (0..chunks) |i| {
            min_acc = @min(min_acc, vecs[i]);
            max_acc = @max(max_acc, vecs[i]);
        }

        min_val = @reduce(.Min, min_acc);
        max_val = @reduce(.Max, max_acc);

        const tail = data[chunks * VEC_F64_LEN ..];
        for (0..(len % VEC_F64_LEN)) |i| {
            if (tail[i] < min_val) min_val = tail[i];
            if (tail[i] > max_val) max_val = tail[i];
        }
    } else {
        for (1..len) |i| {
            if (data[i] < min_val) min_val = data[i];
            if (data[i] > max_val) max_val = data[i];
        }
    }

    return .{ .min = min_val, .max = max_val };
}

// ============================================================================
// PYTHON WRAPPERS — accept buffer protocol objects (array.array, bytes, etc.)
// ============================================================================

fn get_f64_buffer(obj: ?*py.PyObject) ?struct { ptr: [*]f64, len: usize, buf: py.Py_buffer } {
    var buf: py.Py_buffer = undefined;
    if (py.PyObject_GetBuffer(obj, &buf, py.PyBUF_WRITABLE | py.PyBUF_FORMAT) != 0) {
        // Try read-only
        py.PyErr_Clear();
        if (py.PyObject_GetBuffer(obj, &buf, py.PyBUF_FORMAT) != 0) return null;
    }
    // Verify format is 'd' (double/f64)
    if (buf.format != null and buf.format.?[0] != 'd') {
        py.PyBuffer_Release(&buf);
        _ = py.PyErr_Format(py.PyExc_TypeError, "expected array of doubles (format 'd'), got '%s'", buf.format);
        return null;
    }
    const count = @as(usize, @intCast(buf.len)) / @sizeOf(f64);
    return .{
        .ptr = @as([*]f64, @ptrCast(@alignCast(buf.buf))),
        .len = count,
        .buf = buf,
    };
}

fn get_f64_buffer_ro(obj: ?*py.PyObject) ?struct { ptr: [*]const f64, len: usize, buf: py.Py_buffer } {
    var buf: py.Py_buffer = undefined;
    if (py.PyObject_GetBuffer(obj, &buf, py.PyBUF_FORMAT) != 0) return null;
    if (buf.format != null and buf.format.?[0] != 'd') {
        py.PyBuffer_Release(&buf);
        _ = py.PyErr_Format(py.PyExc_TypeError, "expected array of doubles (format 'd'), got '%s'", buf.format);
        return null;
    }
    const count = @as(usize, @intCast(buf.len)) / @sizeOf(f64);
    return .{
        .ptr = @as([*]const f64, @ptrCast(@alignCast(buf.buf))),
        .len = count,
        .buf = buf,
    };
}

fn get_i32_buffer_ro(obj: ?*py.PyObject) ?struct { ptr: [*]const i32, len: usize, buf: py.Py_buffer } {
    var buf: py.Py_buffer = undefined;
    if (py.PyObject_GetBuffer(obj, &buf, py.PyBUF_FORMAT) != 0) return null;
    if (buf.format != null and buf.format.?[0] != 'i') {
        py.PyBuffer_Release(&buf);
        _ = py.PyErr_Format(py.PyExc_TypeError, "expected array of ints (format 'i'), got '%s'", buf.format);
        return null;
    }
    const count = @as(usize, @intCast(buf.len)) / @sizeOf(i32);
    return .{
        .ptr = @as([*]const i32, @ptrCast(@alignCast(buf.buf))),
        .len = count,
        .buf = buf,
    };
}

// sum_f64(array) -> float
fn py_sum_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var arr_obj: ?*py.PyObject = null;
    if (py.PyArg_ParseTuple(args, "O", &arr_obj) == 0) return null;

    const info = get_f64_buffer_ro(arr_obj) orelse return null;
    const result = simd_sum_f64(info.ptr, info.len);
    var buf_copy = info.buf;
    py.PyBuffer_Release(&buf_copy);
    return py.PyFloat_FromDouble(result);
}

// sum_i32(array) -> int
fn py_sum_i32(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var arr_obj: ?*py.PyObject = null;
    if (py.PyArg_ParseTuple(args, "O", &arr_obj) == 0) return null;

    const info = get_i32_buffer_ro(arr_obj) orelse return null;
    const result = simd_sum_i32(info.ptr, info.len);
    var buf_copy = info.buf;
    py.PyBuffer_Release(&buf_copy);
    return py.PyLong_FromLongLong(result);
}

// scale_f64(array, scalar) -> None (in-place)
fn py_scale_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var arr_obj: ?*py.PyObject = null;
    var scalar: f64 = 0;
    if (py.PyArg_ParseTuple(args, "Od", &arr_obj, &scalar) == 0) return null;

    const info = get_f64_buffer(arr_obj) orelse return null;
    simd_scale_f64(info.ptr, info.len, scalar);
    var buf_copy = info.buf;
    py.PyBuffer_Release(&buf_copy);
    return py_none();
}

// dot_f64(a, b) -> float
fn py_dot_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var a_obj: ?*py.PyObject = null;
    var b_obj: ?*py.PyObject = null;
    if (py.PyArg_ParseTuple(args, "OO", &a_obj, &b_obj) == 0) return null;

    const a_info = get_f64_buffer_ro(a_obj) orelse return null;
    const b_info = get_f64_buffer_ro(b_obj) orelse {
        var a_buf = a_info.buf;
        py.PyBuffer_Release(&a_buf);
        return null;
    };

    const len = @min(a_info.len, b_info.len);
    const result = simd_dot_f64(a_info.ptr, b_info.ptr, len);

    var a_buf = a_info.buf;
    var b_buf = b_info.buf;
    py.PyBuffer_Release(&a_buf);
    py.PyBuffer_Release(&b_buf);
    return py.PyFloat_FromDouble(result);
}

// add_f64(dst, a, b) -> None (writes a[i]+b[i] into dst)
fn py_add_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var dst_obj: ?*py.PyObject = null;
    var a_obj: ?*py.PyObject = null;
    var b_obj: ?*py.PyObject = null;
    if (py.PyArg_ParseTuple(args, "OOO", &dst_obj, &a_obj, &b_obj) == 0) return null;

    const dst_info = get_f64_buffer(dst_obj) orelse return null;
    const a_info = get_f64_buffer_ro(a_obj) orelse {
        var dst_buf = dst_info.buf;
        py.PyBuffer_Release(&dst_buf);
        return null;
    };
    const b_info = get_f64_buffer_ro(b_obj) orelse {
        var dst_buf = dst_info.buf;
        var a_buf = a_info.buf;
        py.PyBuffer_Release(&dst_buf);
        py.PyBuffer_Release(&a_buf);
        return null;
    };

    const len = @min(dst_info.len, @min(a_info.len, b_info.len));
    simd_add_f64(dst_info.ptr, a_info.ptr, b_info.ptr, len);

    var dst_buf = dst_info.buf;
    var a_buf = a_info.buf;
    var b_buf = b_info.buf;
    py.PyBuffer_Release(&dst_buf);
    py.PyBuffer_Release(&a_buf);
    py.PyBuffer_Release(&b_buf);
    return py_none();
}

// minmax_f64(array) -> (min, max)
fn py_minmax_f64(_: ?*py.PyObject, args: ?*py.PyObject) callconv(.c) ?*py.PyObject {
    var arr_obj: ?*py.PyObject = null;
    if (py.PyArg_ParseTuple(args, "O", &arr_obj) == 0) return null;

    const info = get_f64_buffer_ro(arr_obj) orelse return null;
    const result = simd_minmax_f64(info.ptr, info.len);
    var buf_copy = info.buf;
    py.PyBuffer_Release(&buf_copy);

    const min_py = py.PyFloat_FromDouble(result.min);
    const max_py = py.PyFloat_FromDouble(result.max);
    if (min_py == null or max_py == null) {
        if (min_py) |m| py.Py_DECREF(m);
        if (max_py) |m| py.Py_DECREF(m);
        return null;
    }
    return py.PyTuple_Pack(2, min_py, max_py);
}

// ============================================================================
// MODULE DEFINITION
// ============================================================================

var module_methods = [_]py.PyMethodDef{
    .{ .ml_name = "sum_f64", .ml_meth = @ptrCast(&py_sum_f64), .ml_flags = py.METH_VARARGS, .ml_doc = "SIMD sum of f64 array." },
    .{ .ml_name = "sum_i32", .ml_meth = @ptrCast(&py_sum_i32), .ml_flags = py.METH_VARARGS, .ml_doc = "SIMD sum of i32 array." },
    .{ .ml_name = "scale_f64", .ml_meth = @ptrCast(&py_scale_f64), .ml_flags = py.METH_VARARGS, .ml_doc = "SIMD scale f64 array in-place." },
    .{ .ml_name = "dot_f64", .ml_meth = @ptrCast(&py_dot_f64), .ml_flags = py.METH_VARARGS, .ml_doc = "SIMD dot product of two f64 arrays." },
    .{ .ml_name = "add_f64", .ml_meth = @ptrCast(&py_add_f64), .ml_flags = py.METH_VARARGS, .ml_doc = "SIMD element-wise add: dst = a + b." },
    .{ .ml_name = "minmax_f64", .ml_meth = @ptrCast(&py_minmax_f64), .ml_flags = py.METH_VARARGS, .ml_doc = "SIMD min/max of f64 array." },
    .{ .ml_name = null, .ml_meth = null, .ml_flags = 0, .ml_doc = null },
};

var module_def = py.PyModuleDef{
    .m_base = std.mem.zeroes(py.PyModuleDef_Base),
    .m_name = "_simd",
    .m_doc = "WASM SIMD batch operations for columnar numeric data",
    .m_size = -1,
    .m_methods = @constCast(&module_methods),
    .m_slots = null,
    .m_traverse = null,
    .m_clear = null,
    .m_free = null,
};

export fn PyInit__simd() ?*py.PyObject {
    return py.PyModule_Create(&module_def);
}
